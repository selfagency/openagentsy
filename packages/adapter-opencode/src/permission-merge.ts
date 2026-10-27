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
 * The effect a pattern has now.
 *
 * A pattern that is not named takes the catch-all, and a catch-all that is
 * not named takes the most permissive effect: OpenCode's own default is the
 * one a permission config does not tighten.
 */
function effectAt(map: Record<string, PermissionEffect>, pattern: string): PermissionEffect {
  const named = map[pattern];
  if (named !== undefined) return named;
  const catchAll = map['*'];
  return catchAll ?? 'allow';
}

/**
 * Merge one action's permissions.
 */
function mergeAction(
  action: string,
  existing: V1PermissionValue | undefined,
  incoming: V1PermissionValue,
): V1PermissionValue {
  const current = asMap(existing);
  const wanted = asMap(incoming);
  const merged: Record<string, PermissionEffect> = { ...current };

  for (const [pattern, effect] of Object.entries(wanted)) {
    const before = effectAt(current, pattern);
    if (STRICTNESS[effect] > STRICTNESS[before]) {
      throw new Error(
        `the permission merge would loosen "${action}" for "${pattern}": ${before} -> ${effect}. ` +
          'A plugin may only tighten a permission, so the merge was refused.',
      );
    }
    merged[pattern] = STRICTNESS[effect] < STRICTNESS[before] ? effect : before;
  }

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
