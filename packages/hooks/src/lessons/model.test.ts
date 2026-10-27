import { describe, expect, it } from 'vitest';
import {
  type Decision,
  type EvalResult,
  isSuiteProof,
  LESSON_STATES,
  type Lesson,
  type LessonState,
  normalizeText,
  packetComplete,
  type StartPacket,
  transition,
} from './model.js';

/**
 * The transition table, as the plan gives it.
 *
 * It is written as one string so the test does not copy the shape of the
 * source: the table is the specification, and a test that reads the
 * specification says what is allowed.
 */
const ALLOWED =
  'candidate=validated,rejected,open_question,no_delta;' +
  'open_question=candidate,rejected;' +
  'validated=applied,rejected;' +
  'applied=superseded,rolled_back';

function allowedFrom(state: LessonState): LessonState[] {
  const entry = ALLOWED.split(';').find((part) => part.startsWith(`${state}=`));
  if (entry === undefined) return [];
  return entry.slice(`${state}=`.length).split(',') as LessonState[];
}

/** A packet that says everything it has to say. */
function completePacket(): StartPacket {
  return {
    futureBehavior: 'read the file before writing to it',
    representativeTask: 'the agent writes to a file that does not exist',
    evidence: ['session-1'],
    owner: 'test:missing-file',
    writeBoundary: ['packages/hooks/src/**'],
    proof: 'evals/missing-file.json',
  };
}

/** A lesson in a state, with a packet that is complete unless told otherwise. */
function lessonIn(state: LessonState, packet?: Partial<StartPacket>): Lesson {
  return {
    id: 'oa-lesson-test0001',
    state,
    summary: 'the file was missing',
    occurrences: 1,
    packet: packet ?? completePacket(),
    history: [],
    kind: 'missing-file',
    detail: 'the file was missing',
    sessions: ['session-1'],
    created_at: '2026-10-27T00:00:00.000Z',
    updated_at: '2026-10-27T00:00:00.000Z',
  };
}

/** A passing proof. */
function passingResult(runs = 3): EvalResult {
  return {
    schema_version: '1',
    lesson_id: 'oa-lesson-test0001',
    artifact_sha256: 'a'.repeat(64),
    started_at: '2026-10-27T00:00:00.000Z',
    finished_at: '2026-10-27T00:00:01.000Z',
    passed: true,
    runs,
    scenarios: [],
  };
}

/** A decision that satisfies the guard of the move it makes. */
function decisionFor(to: LessonState): Decision {
  return {
    decidedBy: 'human',
    reason: 'because',
    ...(to === 'validated' ? { evalResult: passingResult() } : {}),
    ...(to === 'applied' ? { changeRef: 'abc1234' } : {}),
  };
}

describe('the transition table', () => {
  for (const from of LESSON_STATES) {
    for (const to of LESSON_STATES) {
      it(`${from} to ${to} ${allowedFrom(from).includes(to) ? 'succeeds' : 'throws'}`, () => {
        const lesson = lessonIn(from);
        if (allowedFrom(from).includes(to)) {
          const moved = transition(lesson, to, decisionFor(to));
          expect(moved.state).toBe(to);
          expect(moved.history).toHaveLength(1);
          expect(moved.history[0]?.from).toBe(from);
          expect(moved.history[0]?.to).toBe(to);
          expect(moved.history[0]?.decidedBy).toBe('human');
        } else {
          expect(() => transition(lesson, to, decisionFor(to))).toThrow(
            /illegal lesson transition/,
          );
        }
      });
    }
  }
});

describe('the start packet', () => {
  it('is complete when it says everything it has to say', () => {
    expect(packetComplete(completePacket())).toBe(true);
  });

  it('is incomplete without a future behaviour', () => {
    expect(packetComplete({ ...completePacket(), futureBehavior: '  ' })).toBe(false);
  });

  it('is incomplete without a representative task', () => {
    expect(packetComplete({ ...completePacket(), representativeTask: '' })).toBe(false);
  });

  it('is incomplete without evidence', () => {
    expect(packetComplete({ ...completePacket(), evidence: [] })).toBe(false);
  });

  it('is incomplete without an owner', () => {
    const { owner: _owner, ...packet } = completePacket();
    expect(packetComplete(packet)).toBe(false);
  });

  it('is incomplete without a write boundary', () => {
    expect(packetComplete({ ...completePacket(), writeBoundary: [] })).toBe(false);
  });

  it('is incomplete without a proof', () => {
    expect(packetComplete({ ...completePacket(), proof: '' })).toBe(false);
  });

  it('needs a reason for an instructions owner', () => {
    expect(packetComplete({ ...completePacket(), owner: 'instructions' })).toBe(false);
    expect(
      packetComplete({
        ...completePacket(),
        owner: 'instructions',
        ownerJustification: 'no test can hold this',
      }),
    ).toBe(true);
  });

  it('needs a reason for a memory owner', () => {
    expect(packetComplete({ ...completePacket(), owner: 'memory' })).toBe(false);
  });
});

describe('the transition', () => {
  it('does not let an incomplete packet leave a candidate', () => {
    const candidate = lessonIn('candidate', { futureBehavior: 'read the file first' });
    expect(() => transition(candidate, 'validated', decisionFor('validated'))).toThrow(
      /start packet is incomplete/,
    );
    expect(() => transition(candidate, 'open_question', decisionFor('open_question'))).toThrow(
      /start packet is incomplete/,
    );
  });

  it('lets a candidate be rejected and marked as no delta without a packet', () => {
    const candidate = lessonIn('candidate', {});
    expect(transition(candidate, 'rejected', decisionFor('rejected')).state).toBe('rejected');
    expect(transition(candidate, 'no_delta', decisionFor('no_delta')).state).toBe('no_delta');
  });

  it('does not validate without a passing eval result', () => {
    const candidate = lessonIn('candidate');
    expect(() =>
      transition(candidate, 'validated', { decidedBy: 'human', reason: 'because' }),
    ).toThrow(/validation needs a passing eval result/);
    expect(() =>
      transition(candidate, 'validated', {
        decidedBy: 'human',
        reason: 'because',
        evalResult: passingResult(),
      }),
    ).not.toThrow();
  });

  it('does not apply without a change reference', () => {
    const validated = lessonIn('validated');
    expect(() =>
      transition(validated, 'applied', { decidedBy: 'human', reason: 'because' }),
    ).toThrow(/apply needs one owner and a change reference/);
  });

  it('does not apply without an owner', () => {
    const { owner: _owner, ...packet } = completePacket();
    const validated = lessonIn('validated', packet);
    expect(() =>
      transition(validated, 'applied', { decidedBy: 'human', reason: 'because', changeRef: 'abc' }),
    ).toThrow();
  });

  it('keeps the history of the lesson', () => {
    const candidate = lessonIn('candidate');
    const validated = transition(candidate, 'validated', decisionFor('validated'));
    const applied = transition(validated, 'applied', decisionFor('applied'));
    expect(applied.history).toHaveLength(2);
    expect(applied.history[1]?.changeRef).toBe('abc1234');
    expect(applied.history[0]?.evalPassed).toBe(true);
  });
});

describe('the normalised text', () => {
  it('reads two spellings of the same thing as one', () => {
    expect(normalizeText('The file was missing.')).toBe(normalizeText('the file was missing'));
  });
});

describe('the proof', () => {
  it('knows a suite from an artifact', () => {
    expect(isSuiteProof('evals/missing-file.json')).toBe(true);
    expect(isSuiteProof('packages/hooks/evals/suite')).toBe(true);
    expect(isSuiteProof('lessons/missing-file.json')).toBe(false);
  });
});
