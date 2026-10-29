import type { ProjectRoots } from '@openagentsy/core';
import { readReleaseAnswers, recordReleaseAnswer } from '@openagentsy/hooks/release/answers';
import { CATALOGUE } from '../release/catalogue.js';
import { buildReleaseReport, type ReleaseCheckOptions } from '../release/check.js';
import { formatReleaseReport, releaseCheckAsJson } from '../release/format.js';
import type { ReleaseReport } from '../release/types.js';
import { deciderBy } from '../who.js';

/**
 * The release check (§18.3 of the Phase 2 plan).
 *
 * The command reads the project's own state and answers the question the
 * framework asks about a release: does it meet the criteria the framework
 * states? It writes nothing, it reaches no network, and it is a gate for a
 * first-party release: the exit code is the answer.
 *
 * The severity follows the decision the human made on 2026-10-29. A
 * first-party release is held to the criteria hard, and a library is held to
 * them softly: the findings of a library are reported and the release is
 * not blocked.
 */

/**
 * The report of a release, and the exit code the command returns.
 */
export async function runReleaseCheck(
  roots: ProjectRoots,
  options: ReleaseCheckOptions = {},
): Promise<ReleaseReport> {
  return buildReleaseReport(roots, options);
}

export { formatReleaseReport, releaseCheckAsJson };

/** What the answer command did. */
export type ReleaseAnswerReport = {
  /** Whether the answer was recorded. */
  ok: boolean;
  /** The criterion the answer is for. */
  id: string;
  /** Whether the criterion holds. */
  holds: boolean;
  /** How many answers the project holds. */
  count: number;
  /** Why the command refused, when it refused. */
  problem?: string | undefined;
  /** What to do next, when the command refused. */
  hint?: string | undefined;
};

/** What the caller knows about the answer. */
export type ReleaseAnswerOptions = {
  /** Who decided. The person running the command. */
  decidedBy?: string | undefined;
};

/**
 * Record the answer of a person to one criterion.
 *
 * The commitments, the prohibited patterns and the review questions are
 * answered by a person: no machine can read a promise and say whether it was
 * kept. So the check asks for the answer, and this command is where the
 * answer is recorded.
 *
 * An answer of "no" is a refusal of the release, and it may carry a
 * documented exception: the exception is what the framework allows a
 * criterion to hold without holding, and it has to be recorded in
 * `CHANGELOG-SAFETY.md`.
 */
export async function runReleaseAnswer(
  stateRoot: string,
  id: string,
  holds: boolean,
  note: string,
  options: ReleaseAnswerOptions = {},
): Promise<ReleaseAnswerReport> {
  if (!CATALOGUE.some((entry) => entry.id === id)) {
    return {
      ok: false,
      id,
      holds,
      count: (await readReleaseAnswers(stateRoot)).length,
      problem: `${id} is not a criterion the framework states`,
      hint: 'the criteria are the ids of ETHICS.md and SAFETY.md: run oa release-check to see them',
    };
  }
  await recordReleaseAnswer(stateRoot, {
    id,
    holds,
    note,
    decidedBy: deciderBy(options.decidedBy),
    ts: new Date().toISOString(),
  });
  return {
    ok: true,
    id,
    holds,
    count: (await readReleaseAnswers(stateRoot)).length,
  };
}

/**
 * The answer, as it is read.
 */
export function formatReleaseAnswer(report: ReleaseAnswerReport): string {
  if (!report.ok) {
    const hint = report.hint === undefined ? '' : `\nNext: ${report.hint}`;
    return `${report.problem ?? 'the answer was refused'}${hint}\n`;
  }
  const holds = report.holds ? 'holds' : 'does not hold';
  return `${report.id} ${holds} (${report.count} answers in all)\n`;
}
