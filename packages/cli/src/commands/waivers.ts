import { waive } from '@openagentsy/hooks/quality/waive';
import { createWaiverStore } from '@openagentsy/hooks/quality/waivers';
import { deciderBy } from '../who.js';

/**
 * The waiver command.
 *
 * `/oa waive <ruleId> <path> "<reason>"` records a waiver. The person
 * running the command is the decider, and the command is the way a waiver
 * is recorded: the tool the board server registers is denied to every
 * agent role, so an agent may propose a waiver in chat and never record
 * one.
 */

/** What the command did. */
export type WaiverReport = {
  /** Whether the waiver was recorded. */
  ok: boolean;
  /** The rule the waiver is for. */
  ruleId: string;
  /** The path the waiver covers. */
  path: string;
  /** The reason the waiver carries. */
  reason: string;
  /** How many waivers the project holds. */
  count: number;
  /** Why the command refused, when it refused. */
  problem?: string | undefined;
  /** What to do next, when the command refused. */
  hint?: string | undefined;
};

/** What the caller knows about the decision. */
export type WaiverOptions = {
  /** Who decided. The person running the command. */
  decidedBy?: string | undefined;
};

/**
 * Record a waiver.
 *
 * A rule that cannot be waived is refused, and the refusal says so: a floor
 * rule is honesty, function or accessibility, and no reason waives it.
 */
export async function runWaiver(
  root: string,
  ruleId: string,
  path: string,
  reason: string,
  options: WaiverOptions = {},
): Promise<WaiverReport> {
  const store = createWaiverStore(root);
  try {
    const waiver = await waive({
      stateRoot: root,
      ruleId,
      path,
      reason,
      decidedBy: deciderBy(options.decidedBy),
    });
    return {
      ok: true,
      ruleId: waiver.ruleId,
      path: waiver.path,
      reason: waiver.reason,
      count: await store.count(),
    };
  } catch (error) {
    const problem = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      ruleId,
      path,
      reason,
      count: await store.count(),
      problem,
      hint: hintOf(problem),
    };
  }
}

/**
 * What to do next, for the refusal that happened.
 *
 * The three refusals are three different mistakes, and each of them has its
 * own next step: a floor rule is not a mistake at all.
 */
function hintOf(problem: string): string {
  if (problem.includes('cannot be waived')) {
    return 'a floor rule cannot be waived: fix the finding, or turn the rule off for the project';
  }
  if (problem.includes('ten characters')) {
    return 'say why the rule does not apply here, in ten characters at least';
  }
  return 'the rule has to be one the registry knows: the quality check names the ids';
}

/**
 * The decision, as it is read.
 */
export function formatWaiver(report: WaiverReport): string {
  if (!report.ok) {
    const hint = report.hint === undefined ? '' : `\nNext: ${report.hint}`;
    return `${report.problem ?? 'the waiver was refused'}${hint}\n`;
  }
  const count = report.count;
  const waivers = count === 1 ? 'waiver' : 'waivers';
  return `${report.ruleId} is waived for ${report.path} (${count} ${waivers} in all)\n`;
}
