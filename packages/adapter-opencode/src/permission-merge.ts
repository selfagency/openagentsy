import type { PermissionEffect, V1PermissionBlock, V1PermissionValue } from '@openagentsy/core';

/**
 * The permission merge (§8.3).
 *
 * A plugin cannot answer OpenCode's permission prompt, so the commands a
 * person has to approve are asked through OpenCode's own permission config:
 * the plugin's `config` hook writes `"bash": { "git push*": "ask" }` and
 * OpenCode shows its normal prompt.
 *
 * The merge only ever tightens. `allow` becomes `ask`, `ask` becomes
 * `deny`, and a `deny` stays a `deny`. Anything that would loosen a
 * permission throws, because a config that a plugin loosened is a config
 * where the plugin decides what a person may do.
 *
 * The order of the map is part of the permission: OpenCode takes the last
 * matching rule, so a broader rule that lands after a narrower one takes
 * the narrower one's place. The merge therefore places every rule where it
 * tightens and nowhere that it would loosen.
 */

/**
 * How strict an effect is.
 *
 * The order is the order of the permission itself: a `deny` is the strictest
 * and an `allow` is the most permissive, so a merge that moves to a smaller
 * number tightens and a merge that moves to a larger number loosens.
 */
const STRICTNESS: Record<PermissionEffect, number> = {
  deny: 0,
  ask: 1,
  allow: 2,
};

/**
 * The effect of a value, when the value names one.
 *
 * A value the host wrote in a shape this merge does not know is read as the
 * most permissive effect: a shape that is not understood cannot be loosened
 * by accident, because every incoming effect tightens it.
 */
function effectOf(value: unknown): PermissionEffect {
  if (value === 'deny' || value === 'ask' || value === 'allow') return value;
  return 'allow';
}

/**
 * Whether a pattern is a literal: a rule that names one thing.
 */
function isLiteral(pattern: string): boolean {
  return !pattern.includes('*');
}

/**
 * The literal a prefix pattern stands for.
 *
 * An OpenCode permission pattern is a wildcard where a single asterisk
 * matches zero or more of any character, so `git push*` is the prefix
 * `git push` and matches everything that starts with it.
 */
function prefixOf(pattern: string): string | undefined {
  if (!pattern.endsWith('*')) return undefined;
  if (pattern.indexOf('*') !== pattern.length - 1) return undefined;
  return pattern.slice(0, -1);
}

/**
 * Whether a pattern matches a string.
 *
 * The asterisk is the only wildcard, and it matches any run of characters.
 */
function matchesPattern(pattern: string, text: string): boolean {
  const parts = pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${parts.join('.*')}$`).test(text);
}

/**
 * Whether two patterns can match the same string.
 *
 * Two literals overlap when they are the same string, a literal and a
 * pattern overlap when the pattern matches the literal, and two prefix
 * patterns overlap when one prefix starts with the other. A pattern with a
 * wildcard in the middle overlaps with everything it cannot be proven not
 * to overlap: an overlap that is assumed moves a rule, and a rule that
 * moves is safe, while an overlap that is missed can loosen a permission.
 */
function patternsOverlap(a: string, b: string): boolean {
  if (isLiteral(a) && isLiteral(b)) return a === b;
  if (isLiteral(a)) return matchesPattern(b, a);
  if (isLiteral(b)) return matchesPattern(a, b);
  const prefixA = prefixOf(a);
  const prefixB = prefixOf(b);
  if (prefixA !== undefined && prefixB !== undefined) {
    return prefixA.startsWith(prefixB) || prefixB.startsWith(prefixA);
  }
  return true;
}

/**
 * A value as a map of patterns to effects.
 *
 * The shorthand form of a single rule is the effect alone, and it is the
 * catch-all: `bash: "allow"` is `bash: { "*": "allow" }`.
 */
function asMap(value: V1PermissionValue | undefined): Record<string, PermissionEffect> {
  if (value === undefined) return {};
  if (typeof value === 'string') return { '*': value };
  const map: Record<string, PermissionEffect> = {};
  for (const [pattern, effect] of Object.entries(value)) {
    map[pattern] = effectOf(effect);
  }
  return map;
}

/**
 * The effect a rule ends up with when it tightens another.
 */
function tighten(
  action: string,
  pattern: string,
  before: PermissionEffect,
  effect: PermissionEffect,
): PermissionEffect {
  if (STRICTNESS[effect] > STRICTNESS[before]) {
    throw new Error(
      `the permission merge would loosen "${action}" for "${pattern}": ${before} -> ${effect}. ` +
        'A plugin may only tighten a permission, so the merge was refused.',
    );
  }
  return STRICTNESS[effect] < STRICTNESS[before] ? effect : before;
}

/**
 * Where a new rule has to go.
 *
 * A rule that overlaps a stricter one has to come before it, or the
 * stricter one would be lost: a broad `git push*` that lands after a
 * narrow `git push --force` deny takes the deny's place, because OpenCode
 * takes the last matching rule. A rule that overlaps a looser one has to
 * come after it, or the loosening would take the new rule's place.
 *
 * A rule that covers a stricter one overlaps it, so the overlap is what
 * this answers. A rule that cannot be placed both ways refuses the merge:
 * a permission that cannot be tightened without loosening another one is
 * not tightened at all.
 */
function placementOf(
  rules: readonly (readonly [string, PermissionEffect])[],
  pattern: string,
  effect: PermissionEffect,
): number {
  let after = -1;
  let before = rules.length;
  for (const [index, entry] of rules.entries()) {
    const [key, keyEffect] = entry;
    if (!patternsOverlap(pattern, key)) continue;
    if (STRICTNESS[keyEffect] < STRICTNESS[effect]) {
      before = Math.min(before, index);
    } else if (STRICTNESS[effect] < STRICTNESS[keyEffect]) {
      after = Math.max(after, index);
    }
  }
  const at = after + 1;
  if (at > before) {
    throw new Error(
      `the permission merge would loosen "${pattern}": a stricter rule for the same command ` +
        'would have to come after it. A plugin may only tighten a permission, so the merge ' +
        'was refused.',
    );
  }
  return at;
}

/**
 * Merge one action's permissions.
 *
 * The rules are placed, not just added.
 */
function mergeAction(
  action: string,
  existing: V1PermissionValue | undefined,
  incoming: V1PermissionValue,
): V1PermissionValue {
  const current = asMap(existing);
  const wanted = asMap(incoming);
  const rules: [string, PermissionEffect][] = Object.entries(current);

  for (const [pattern, effect] of Object.entries(wanted)) {
    const known = rules.findIndex(([key]) => key === pattern);
    const before = known === -1 ? undefined : rules[known]?.[1];
    // A rule that is written again is placed again. It was placed when it
    // first arrived, and the rules around it have moved since, so a rule
    // that now overlaps a looser rule after it would stay buried there.
    const placed = before === undefined ? effect : tighten(action, pattern, before, effect);
    if (known !== -1) rules.splice(known, 1);
    rules.splice(placementOf(rules, pattern, placed), 0, [pattern, placed]);
  }

  const merged: Record<string, PermissionEffect> = {};
  for (const [pattern, effect] of rules) merged[pattern] = effect;

  // The shorthand stays shorthand when both sides were shorthand, so a
  // config that said `bash: "allow"` still says it.
  if (typeof existing === 'string' && typeof incoming === 'string') {
    return merged['*'] ?? 'allow';
  }
  return merged;
}

/**
 * Merge the permissions the guardrails ask for into a permission config.
 *
 * The merge is a pure function: it returns the new block and leaves the one
 * it was given alone. The caller decides what to do with it, and a caller
 * that gets a refusal keeps the tighter config it already had.
 */
export function mergePermissions(
  current: V1PermissionBlock,
  incoming: V1PermissionBlock,
): V1PermissionBlock {
  const merged: V1PermissionBlock = { ...current };
  for (const [action, value] of Object.entries(incoming)) {
    merged[action] = mergeAction(action, merged[action], value);
  }
  return merged;
}

/**
 * The permission entries a list of commands asks for.
 *
 * The list comes from the project's `openagentsy.jsonc` (`hooks.
 * approvalFor`), and every command in it becomes a pattern of the shell
 * tool. The pattern is the command and a wildcard, so `git push` asks about
 * `git push --force` as well.
 *
 * The key is `bash`, because that is the name OpenCode 1 gives the shell
 * tool: a `shell` key is dropped silently by the pinned version.
 */
export function permissionEntriesFor(approvalFor: readonly string[]): V1PermissionBlock {
  const bash: Record<string, PermissionEffect> = {};
  for (const command of approvalFor) {
    const trimmed = command.trim();
    if (trimmed === '') continue;
    bash[`${trimmed}*`] = 'ask';
  }
  if (Object.keys(bash).length === 0) return {};
  return { bash };
}
