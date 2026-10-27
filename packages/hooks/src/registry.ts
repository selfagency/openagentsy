/**
 * The hook registry.
 *
 * A rule says what must hold; a moment says when it is checked. The
 * registry holds the rules, puts them in the order they run, and runs the
 * rules of one moment.
 *
 * `@agentsy/runtime` would provide this, but it is not on npm (verified
 * 2026-10-27), so the registry lives here. It is small on purpose: an
 * ordered list, a chain that stops, and the reasons it stopped.
 */

/** The moments a rule is checked at. */
export type HookEvent =
  | 'UserPromptSubmit'
  | 'PreToolCall'
  | 'PostToolCall'
  | 'PreCompact'
  | 'SubagentStop'
  | 'PreResponse'
  | 'PostResponse'
  | 'ModelCall';

/**
 * What a handler answers.
 *
 * `{ continue: true }` says the call may go on, `{ continue: false, reason }`
 * stops it and says why, and `{ transform }` hands the caller something to
 * apply to the call.
 */
export type HandlerResult =
  | { continue: true }
  | { continue: false; reason: string }
  | { transform: unknown };

/** A rule: an id, the moment it is checked at, and the handler. */
export interface Rule {
  /** The name the rule is known by. */
  id: string;
  /** The moment the rule is checked at. */
  event: HookEvent;
  /** A blocking rule runs before every other rule. */
  block?: boolean;
  /** The order among the rules of one kind; the higher number runs first. */
  priority?: number;
  /** The roles the rule applies to; a rule without roles applies to all. */
  roles?: string[];
  /** The check itself. */
  handler: (event: unknown) => Promise<HandlerResult> | HandlerResult;
}

/** The priority a blocking rule runs at, so that it runs first. */
export const BLOCK_PRIORITY = 1000;

/** What one run of a moment's rules produced. */
export interface RunResult {
  /** Whether the call may go on. */
  continue: boolean;
  /** Why the chain stopped, in the order the rules stopped it. */
  reasons: string[];
  /** What the handlers asked to change, in the order they asked. */
  transformed: unknown[];
}

/** The registry: the rules, in the order they run. */
export interface HookRegistry {
  /** Run the rules of one moment. */
  run(event: HookEvent, input: unknown): Promise<RunResult>;
  /** The rules in the order they run; one moment's rules when a moment is named. */
  rules(event?: HookEvent): Rule[];
}

/**
 * The rules in the order they run.
 *
 * A blocking rule runs first, because a rule that stops a call is worth
 * more than a rule that only notes something. Then the priority, highest
 * first, and then the order the rules were written in, so two rules of the
 * same priority keep the order a person gave them.
 */
export function orderRules(rules: readonly Rule[]): Rule[] {
  return rules
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => {
      const aBlock = a.rule.block === true;
      const bBlock = b.rule.block === true;
      if (aBlock !== bBlock) return aBlock ? -1 : 1;
      const priority = (b.rule.priority ?? 0) - (a.rule.priority ?? 0);
      if (priority !== 0) return priority;
      return a.index - b.index;
    })
    .map((entry) => entry.rule);
}

/**
 * The role a call is made for.
 *
 * A rule can be scoped to a role, and the event carries the role. An event
 * with no role runs no scoped rule: a rule that applies to one role cannot
 * apply to an unknown one.
 */
function roleOf(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const role = (input as { role?: unknown }).role;
  return typeof role === 'string' ? role : undefined;
}

/**
 * Run the rules of one moment.
 *
 * The chain stops at the first rule that stops it, and the reason is kept.
 * The transforms are all returned, in order, because a transform is a
 * change and a change is not a stop.
 */
export async function run(
  event: HookEvent,
  rules: readonly Rule[],
  input: unknown,
): Promise<RunResult> {
  const reasons: string[] = [];
  const transformed: unknown[] = [];
  const role = roleOf(input);
  for (const rule of orderRules(rules)) {
    if (rule.event !== event) continue;
    if (rule.roles !== undefined && (role === undefined || !rule.roles.includes(role))) {
      continue;
    }
    const result = await rule.handler(input);
    if ('transform' in result) {
      transformed.push(result.transform);
      continue;
    }
    if (result.continue === false) {
      reasons.push(result.reason);
      break;
    }
  }
  return { continue: reasons.length === 0, reasons, transformed };
}

/**
 * The registry for a set of rules.
 *
 * The rules are ordered once, so a caller can read them in the order they
 * run and a run does not reorder them again.
 */
export function createOaRegistry(rules: readonly Rule[]): HookRegistry {
  const ordered = orderRules(rules);
  return {
    run: (event, input) => run(event, ordered, input),
    rules: (event) =>
      event === undefined ? ordered : ordered.filter((rule) => rule.event === event),
  };
}
