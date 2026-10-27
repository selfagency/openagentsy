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
 * through the safety suite's own runner, and it has to pass three times: a
 * suite that passed once has not shown that it always passes.
 */
export function proofSufficient(proof: string, result: EvalResult | undefined): boolean {
  if (result?.passed !== true) return false;
  if (isSuiteProof(proof)) return result.runs >= SUITE_RUNS;
  return true;
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

  if (target === 'validated' && !proofSufficient(lesson.packet.proof ?? '', input.evalResult)) {
    return {
      ok: false,
      reason: isSuiteProof(lesson.packet.proof ?? '')
        ? `a suite proof needs ${SUITE_RUNS} passing runs`
        : 'validation needs a passing eval result for this lesson',
      hint: 'run the proof and hand the result to the decision',
    };
  }

  const decision: Decision = {
    decidedBy: input.decidedBy,
    reason: input.reason,
    ...(input.evalResult === undefined ? {} : { evalResult: input.evalResult }),
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
