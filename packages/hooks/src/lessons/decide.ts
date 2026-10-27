import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { assertConsistent, runEvalArtifact } from '../eval/runner.js';
import type { EvalResult } from '../eval/types.js';
import {
  type Decision,
  isSuiteProof,
  type Lesson,
  LessonError,
  type LessonState,
  transition,
} from './model.js';
import { readLesson, writeLesson } from './store.js';

/**
 * The decision.
 *
 * A person decides what happens to a lesson: it is validated, applied,
 * rejected, or observed. The tool that carries the decision is denied to
 * every agent role by the permission map, and the command that runs this
 * code is the one a person uses, so `decidedBy` is the human.
 */

/** What a person can do to a lesson. */
export const LESSON_ACTIONS = ['validate', 'apply', 'reject', 'observe'] as const;

export type LessonAction = (typeof LESSON_ACTIONS)[number];

/**
 * The states an observation can land a lesson in.
 *
 * An observation is what a person saw: the behaviour did not change, a newer
 * lesson took over, or the claim needs an answer before it can go on.
 */
export const OBSERVE_OUTCOMES = ['rolled_back', 'superseded', 'open_question'] as const;

export type ObserveOutcome = (typeof OBSERVE_OUTCOMES)[number];

/** How many runs a suite proof needs. */
export const SUITE_RUNS = 3;

/** What a person decided. */
export type DecideInput = {
  /** The lesson the decision is about. */
  id: string;
  /** What was decided. */
  action: LessonAction;
  /** Who decided. The human. */
  decidedBy: string;
  /** Why. */
  reason: string;
  /** The proof, when the decision rests on one. */
  evalResult?: EvalResult;
  /** The change the decision names, when it applies one. */
  changeRef?: string;
  /** The state an observation lands in, when the default is not wanted. */
  outcome?: ObserveOutcome;
};

/** What the decision did. */
export type DecideOutcome =
  | { ok: true; lesson: Lesson }
  | { ok: false; reason: string; hint: string };

/**
 * The state an observation of a lesson in this state lands in.
 *
 * An applied lesson is observed after the fact: the behaviour either changed
 * or it did not, and a behaviour that did not change is a rollback. A
 * candidate is observed while it is being considered: an observation that
 * raises a question leaves it as a question, and an answered question goes
 * back to being a candidate.
 */
export function observeTarget(state: LessonState): LessonState | undefined {
  switch (state) {
    case 'applied':
      return 'rolled_back';
    case 'candidate':
      return 'open_question';
    case 'open_question':
      return 'candidate';
    default:
      return undefined;
  }
}

/**
 * The state a decision moves the lesson to.
 */
export function targetState(lesson: Lesson, input: DecideInput): LessonState | undefined {
  switch (input.action) {
    case 'validate':
      return 'validated';
    case 'apply':
      return 'applied';
    case 'reject':
      return 'rejected';
    case 'observe':
      if (input.outcome === undefined) return observeTarget(lesson.state);
      if (!(OBSERVE_OUTCOMES as readonly string[]).includes(input.outcome)) return undefined;
      return input.outcome;
    default:
      return undefined;
  }
}

/**
 * Whether the proof is enough for the decision.
 *
 * An artifact proof is one run. A proof that points at an evals/ suite runs
 * through the safety suite's own runner, so it is judged by three runs
 * instead of one.
 */
export function proofSufficient(proof: string, result: EvalResult | undefined): boolean {
  if (result?.passed !== true) return false;
  if (isSuiteProof(proof)) return result.runs >= SUITE_RUNS;
  return true;
}

/**
 * The path of the proof of a lesson.
 */
export function proofPath(root: string, proof: string): string {
  return isAbsolute(proof) ? proof : join(root, proof);
}

/**
 * The checks a result has to pass before a decision rests on it.
 *
 * A result is not trusted: it has to agree with its own assertions, it has
 * to be about this lesson, and it has to have passed. A result that a person
 * wrote by hand fails the first check as soon as its verdicts disagree with
 * its assertions.
 */
function checkResult(
  result: EvalResult,
  lesson: Lesson,
): { ok: false; reason: string; hint: string } | undefined {
  try {
    assertConsistent(result);
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'the proof result is inconsistent',
      hint: 'the result has to agree with its own assertions',
    };
  }
  if (result.lesson_id !== lesson.id) {
    return {
      ok: false,
      reason: `the proof result is about ${result.lesson_id}, not about this lesson`,
      hint: 'run the proof for this lesson',
    };
  }
  if (result.passed !== true) {
    return {
      ok: false,
      reason: 'the proof did not pass',
      hint: 'a lesson is only validated by a proof that passes',
    };
  }
  return undefined;
}

/**
 * The proof of a lesson, checked and, where it can be, run.
 *
 * A proof that is an artifact is run here, so the verdict is the runner's
 * and not a file somebody wrote. A proof that is an evals/ suite is run by
 * the safety suite's own runner, so the result of its three runs is handed
 * to the decision, and it is checked against the lesson.
 */
async function verifyProof(
  root: string,
  lesson: Lesson,
  supplied: EvalResult | undefined,
): Promise<{ ok: true; result: EvalResult } | { ok: false; reason: string; hint: string }> {
  const proof = lesson.packet.proof ?? '';
  if (proof.trim() === '') {
    return {
      ok: false,
      reason: 'the lesson has no proof',
      hint: 'name the eval artifact the lesson is proved by',
    };
  }
  if (isSuiteProof(proof)) return verifySuiteProof(lesson, supplied);
  return verifyArtifactProof(root, lesson, proof, supplied);
}

/**
 * The proof of a lesson that is an evals/ suite.
 *
 * The suite runs through the safety suite's own runner, so the result of its
 * three runs is handed to the decision, and it is checked against the lesson.
 */
function verifySuiteProof(
  lesson: Lesson,
  supplied: EvalResult | undefined,
): { ok: true; result: EvalResult } | { ok: false; reason: string; hint: string } {
  if (supplied === undefined) {
    return {
      ok: false,
      reason: 'a suite proof needs the result of its three runs',
      hint: 'run the suite and hand the result to the decision',
    };
  }
  const problem = checkResult(supplied, lesson);
  if (problem !== undefined) return problem;
  if (supplied.runs < SUITE_RUNS) {
    return {
      ok: false,
      reason: `a suite proof needs ${SUITE_RUNS} passing runs`,
      hint: 'run the suite three times and hand the result to the decision',
    };
  }
  return { ok: true, result: supplied };
}

/**
 * The proof of a lesson that is an eval artifact.
 *
 * The artifact is run here, so the verdict is the runner's and not a file
 * somebody wrote. A result that was handed to the decision has to agree with
 * the run.
 */
async function verifyArtifactProof(
  root: string,
  lesson: Lesson,
  proof: string,
  supplied: EvalResult | undefined,
): Promise<{ ok: true; result: EvalResult } | { ok: false; reason: string; hint: string }> {
  let run: EvalResult;
  try {
    run = await runEvalArtifact({
      artifactPath: proofPath(root, proof),
      workspace: root,
      stateRoot: root,
      lessonId: lesson.id,
    });
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'the proof could not be run',
      hint: 'the proof has to run before the lesson can be validated',
    };
  }
  if (supplied !== undefined) {
    const problem = checkResult(supplied, lesson);
    if (problem !== undefined) return problem;
    if (supplied.artifact_sha256 !== run.artifact_sha256) {
      return {
        ok: false,
        reason: 'the proof result does not match the proof',
        hint: 'run the proof again and hand the result to the decision',
      };
    }
  }
  if (run.passed !== true) {
    return {
      ok: false,
      reason: 'the proof did not pass',
      hint: 'a lesson is only validated by a proof that passes',
    };
  }
  return { ok: true, result: run };
}

/**
 * Record a decision.
 *
 * The move itself is the model's: this only finds the lesson, works out
 * where the decision lands it, and writes the result. A decision that the
 * lifecycle refuses is refused here too, with the reason the model gives.
 */
export async function decideLesson(
  root: string,
  input: DecideInput,
  now: () => Date = () => new Date(),
): Promise<DecideOutcome> {
  const lesson = await readLesson(root, input.id);
  if (lesson === undefined) {
    return {
      ok: false,
      reason: `the lesson ${input.id} is not there`,
      hint: 'run the lessons inbox to see what is waiting for a decision',
    };
  }

  const target = targetState(lesson, input);
  if (target === undefined) {
    return {
      ok: false,
      reason: `a ${lesson.state} lesson has no state an observation can land in`,
      hint: 'a validated lesson is rejected rather than observed, and a lesson that is already final is history',
    };
  }

  let evalResult = input.evalResult;
  if (target === 'validated') {
    const proof = await verifyProof(root, lesson, input.evalResult);
    if (!proof.ok) return { ok: false, reason: proof.reason, hint: proof.hint };
    evalResult = proof.result;
  }

  const decision: Decision = {
    decidedBy: input.decidedBy,
    reason: input.reason,
    ...(evalResult === undefined ? {} : { evalResult }),
    ...(input.changeRef === undefined ? {} : { changeRef: input.changeRef }),
  };

  let moved: Lesson;
  try {
    moved = transition(lesson, target, decision, now);
  } catch (error) {
    if (error instanceof LessonError) {
      return { ok: false, reason: error.message, hint: error.hint };
    }
    throw error;
  }
  await writeLesson(root, moved);
  return { ok: true, lesson: moved };
}

/**
 * The proof file of a lesson, as it is read.
 */
export async function readProof(root: string, proof: string): Promise<string | undefined> {
  try {
    return await readFile(proofPath(root, proof), 'utf8');
  } catch {
    return undefined;
  }
}
