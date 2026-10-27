import type { EvalResult } from '../eval/types.js';

export type { EvalResult };

/**
 * The lesson model.
 *
 * A lesson is a claim about behaviour that a person has not decided on yet.
 * It starts as a candidate and it only becomes a fact through states, and
 * every state is a gate:
 *
 * - a candidate cannot leave without a start packet that says what should
 *   happen differently, what would show it, and who owns the change;
 * - a validated lesson needs a passing eval result, because a claim with no
 *   proof is an opinion;
 * - an applied lesson needs an owner and a change reference, because a change
 *   nobody owns is a change nobody can roll back.
 */

/** Every state a lesson can be in. */
export const LESSON_STATES = [
  'candidate',
  'validated',
  'applied',
  'rejected',
  'superseded',
  'rolled_back',
  'no_delta',
  'open_question',
] as const;

export type LessonState = (typeof LESSON_STATES)[number];

/**
 * The states each state may move to.
 *
 * The map is the whole of the lifecycle. A state with no entry in it is
 * final: a rejected lesson, a rolled back one and a superseded one are
 * history, and a history is not edited.
 */
const NEXT: Record<LessonState, LessonState[]> = {
  candidate: ['validated', 'rejected', 'open_question', 'no_delta'],
  open_question: ['candidate', 'rejected'],
  validated: ['applied', 'rejected'],
  applied: ['superseded', 'rolled_back'],
  rejected: [],
  superseded: [],
  rolled_back: [],
  no_delta: [],
};

/**
 * Who holds the change.
 *
 * The owner is the narrowest thing that can hold the lesson, in this order:
 * a test or a validator, the owning skill or role file, the project
 * instructions, a memory note. The last two are the ones that cannot be
 * enforced in code, so they need a reason.
 */
export type Owner =
  | `test:${string}`
  | `validator:${string}`
  | `skill:${string}`
  | `role:${string}`
  | 'instructions'
  | 'memory';

/** The owners that cannot enforce anything, so they need a reason. */
const WEAK_OWNERS = ['instructions', 'memory'] as const;

/**
 * The packet that says what a lesson asks for.
 *
 * It is what the person reads before deciding, so every field is a question
 * that has an answer: what should happen differently, which task would show
 * it, what is the evidence, who owns the change, which files may change and
 * where the proof is.
 */
export interface StartPacket {
  /** What the agent should do differently next time. */
  futureBehavior: string;
  /** One concrete scenario that should now succeed. */
  representativeTask: string;
  /** The ledger waste ids, the session ids, the failing test, the correction. */
  evidence: string[];
  /** Exactly one durable owner. */
  owner: Owner;
  /** Why code or a skill cannot hold the lesson. Needed for a weak owner. */
  ownerJustification?: string;
  /** The files the change may touch. */
  writeBoundary: string[];
  /** The path to an eval artifact, or to an evals/ suite. */
  proof: string;
}

/** One decision, and the state it moved the lesson to. */
export interface Transition {
  from: LessonState;
  to: LessonState;
  /** Who decided. */
  decidedBy: string;
  /** Why. */
  reason: string;
  /** ISO 8601. */
  ts: string;
  /** The commit or the change the decision names. */
  changeRef?: string;
  /** Whether the eval result passed, when one was part of the decision. */
  evalPassed?: boolean;
}

/**
 * A lesson.
 *
 * The summary says what happened, the occurrences say how often, and the
 * history says who decided what. A count is not evidence: a lesson that
 * happened often is still a claim.
 */
export interface Lesson {
  id: string;
  state: LessonState;
  summary: string;
  occurrences: number;
  packet: Partial<StartPacket>;
  history: Transition[];
  /** The waste kind the lesson came from. */
  kind: string;
  /** The detail of the waste, normalised into the shape it was compared by. */
  detail: string;
  /** The sessions the waste was seen in. */
  sessions: string[];
  /** ISO 8601. */
  created_at: string;
  /** ISO 8601. */
  updated_at: string;
}

/**
 * A decision about a lesson.
 *
 * The decision is the person's, and it says who made it: an agent may
 * propose, but the map keeps it from deciding.
 */
export interface Decision {
  decidedBy: string;
  reason: string;
  /** The proof, when the decision rests on one. */
  evalResult?: EvalResult;
  /** The change the decision names, when it applies one. */
  changeRef?: string;
}

/**
 * The error the lesson model raises.
 *
 * It carries a hint, like every other error here: the message says what
 * happened, the hint says what to do next.
 */
export class LessonError extends Error {
  readonly hint: string;

  constructor(message: string, hint: string) {
    super(message);
    this.name = 'LessonError';
    this.hint = hint;
  }
}

/**
 * Whether a value names an owner.
 */
export function isOwner(value: unknown): value is Owner {
  if (typeof value !== 'string' || value.length === 0) return false;
  if ((WEAK_OWNERS as readonly string[]).includes(value)) return true;
  return /^(test|validator|skill|role):\S+$/.test(value);
}

/**
 * Whether the owner is one that cannot hold the lesson in code.
 */
export function isWeakOwner(owner: Owner): boolean {
  return (WEAK_OWNERS as readonly string[]).includes(owner);
}

/**
 * Whether a value says something.
 */
function hasText(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Whether a list holds something.
 */
function hasItems(values: string[] | undefined): boolean {
  return Array.isArray(values) && values.length > 0;
}

/**
 * Whether the packet says everything it has to say.
 *
 * A weak owner needs its reason: an instruction or a memory note holds a
 * lesson that code cannot, and the person has to read why.
 */
export function packetComplete(packet: Partial<StartPacket>): boolean {
  const owner = packet.owner;
  if (!isOwner(owner)) return false;
  if (!hasText(packet.futureBehavior) || !hasText(packet.representativeTask)) return false;
  if (!hasItems(packet.evidence) || !hasItems(packet.writeBoundary)) return false;
  if (!hasText(packet.proof)) return false;
  if (isWeakOwner(owner) && !hasText(packet.ownerJustification)) return false;
  return true;
}

/**
 * The states a lesson may move to from where it is.
 */
export function nextStates(state: LessonState): LessonState[] {
  return NEXT[state];
}

/**
 * Move a lesson to another state.
 *
 * The move throws in four cases, and only in these four:
 *
 * - the move is not one the lifecycle allows;
 * - the move is not a rejection while the start packet is incomplete, so a
 *   candidate cannot leave without saying what it asks for;
 * - the move validates without a passing eval result;
 * - the move applies without an owner and a change reference.
 */
export function transition(
  lesson: Lesson,
  to: LessonState,
  decision: Decision,
  now: () => Date = () => new Date(),
): Lesson {
  if (!NEXT[lesson.state].includes(to)) {
    throw new LessonError(
      `illegal lesson transition ${lesson.state} → ${to}`,
      `a lesson can move to ${NEXT[lesson.state].join(', ') || 'nothing'}`,
    );
  }
  if (to !== 'rejected' && to !== 'no_delta' && !packetComplete(lesson.packet)) {
    throw new LessonError(
      'the start packet is incomplete',
      'a lesson needs a future behaviour, a representative task, evidence, an owner, a write boundary and a proof',
    );
  }
  if (to === 'validated' && decision.evalResult?.passed !== true) {
    throw new LessonError(
      'validation needs a passing eval result for this lesson',
      'run the proof and hand the result to the decision',
    );
  }
  if (to === 'applied' && (!decision.changeRef || !lesson.packet.owner)) {
    throw new LessonError(
      'apply needs one owner and a change reference',
      'name the commit or the change that carries the lesson, and the owner that holds it',
    );
  }

  const stamp = now().toISOString();
  const entry: Transition = {
    from: lesson.state,
    to,
    decidedBy: decision.decidedBy,
    reason: decision.reason,
    ts: stamp,
    ...(decision.changeRef === undefined ? {} : { changeRef: decision.changeRef }),
    ...(decision.evalResult === undefined ? {} : { evalPassed: decision.evalResult.passed }),
  };
  return {
    ...lesson,
    state: to,
    history: [...lesson.history, entry],
    updated_at: stamp,
  };
}

/**
 * A text as the dedup sees it: lowercased, whitespace collapsed, and
 * without the punctuation that carries no meaning.
 *
 * The summary of a lesson and the detail of a waste are both compared this
 * way, so "Read the file." and "read the file" are one lesson.
 */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whether a proof points at an evals/ suite rather than at an artifact.
 *
 * A suite runs through the safety suite's own runner, so it is judged by
 * three runs instead of one.
 */
export function isSuiteProof(proof: string): boolean {
  const segments = proof.split(/[\\/]+/).filter((segment) => segment.length > 0);
  return segments.includes('evals');
}
