import { allRegistry } from '@openagentsy/quality';
import { createWaiverStore, type Waiver, WaiverSchema } from './waivers.js';

/**
 * The recording of a waiver.
 *
 * A person records a waiver; an agent may only propose one. The command a
 * person runs and the tool the server registers both call this function, so
 * the decision has one implementation and one audit trail.
 *
 * The module is not exported from the package barrel: the whole rule set
 * carries the TypeScript compiler, and the plugin must not pay for it. The
 * callers reach it by its own path, `@openagentsy/hooks/quality/waive`.
 */

/** What a person decides. */
export interface WaiveInput {
  /** Where the waivers live. */
  stateRoot: string;
  /** The rule the waiver is for. */
  ruleId: string;
  /** The path the waiver covers. */
  path: string;
  /** Why. Ten characters at least. */
  reason: string;
  /** Who decided. A person, never an agent. */
  decidedBy: string;
  /** When the decision was made. */
  ts?: string | undefined;
}

/**
 * Record a waiver.
 *
 * A rule that cannot be waived is refused: a floor rule is honesty, function
 * or accessibility, and the registry refuses a waivable floor rule at load.
 * A reason that is too short is refused too, because a waiver without a
 * reason is a decision nobody can check.
 */
export async function waive(input: WaiveInput): Promise<Waiver> {
  const rule = allRegistry.rules().find((candidate) => candidate.id === input.ruleId);
  if (rule === undefined) {
    throw new Error(`no rule is named ${input.ruleId}`);
  }
  if (!rule.waivable) {
    throw new Error(`the rule ${input.ruleId} cannot be waived`);
  }
  if (input.reason.trim().length < 10) {
    throw new Error('a waiver needs a reason of ten characters at least');
  }
  const waiver = WaiverSchema.safeParse({
    ruleId: input.ruleId,
    path: input.path,
    reason: input.reason,
    decidedBy: input.decidedBy,
    ts: input.ts ?? new Date().toISOString(),
  });
  if (!waiver.success) {
    throw new Error(`the waiver is not valid: ${issuesOf(waiver.error)}`);
  }
  await createWaiverStore(input.stateRoot).add(waiver.data);
  return waiver.data;
}

/** What is wrong with a waiver, in one line. */
function issuesOf(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): string {
  return error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
}
