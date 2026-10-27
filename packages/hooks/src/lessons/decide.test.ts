import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureCandidate } from './capture.js';
import { decideLesson, proofSufficient } from './decide.js';
import type { EvalResult, StartPacket } from './model.js';
import { readLesson } from './store.js';

async function temporaryRoot(): Promise<{ root: string; remove: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'openagentsy-decide-'));
  return { root, remove: () => rm(root, { recursive: true, force: true }) };
}

/** A packet that says everything it has to say. */
function completePacket(): Partial<StartPacket> {
  return {
    futureBehavior: 'read the file before writing to it',
    representativeTask: 'the agent writes to a file that does not exist',
    evidence: ['session-1'],
    owner: 'test:missing-file',
    writeBoundary: ['packages/hooks/src/**'],
    proof: 'lessons/missing-file.json',
  };
}

/** A passing proof, with the number of runs it took. */
function result(runs: number, passed = true): EvalResult {
  return {
    schema_version: '1',
    lesson_id: 'oa-lesson-test0001',
    artifact_sha256: 'a'.repeat(64),
    started_at: '2026-10-27T00:00:00.000Z',
    finished_at: '2026-10-27T00:00:01.000Z',
    passed,
    runs,
    scenarios: [],
  };
}

/** A candidate with a complete packet, ready to be decided about. */
async function candidate(root: string, proof = 'lessons/missing-file.json') {
  const outcome = await captureCandidate(root, {
    summary: 'the agent wrote to a file that does not exist',
    observations: [{ kind: 'missing-file', detail: 'the file was missing', session: 'session-1' }],
    explicitCorrection: true,
    packet: { ...completePacket(), proof },
  });
  if (!outcome.ok) throw new Error('the candidate was not created');
  return outcome.lesson;
}

describe('the decision', () => {
  it('validates a candidate with a passing proof', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      const lesson = await candidate(root);
      const outcome = await decideLesson(root, {
        id: lesson.id,
        action: 'validate',
        decidedBy: 'human',
        reason: 'the proof passes',
        evalResult: result(1),
      });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.lesson.state).toBe('validated');
        expect(outcome.lesson.history[0]?.decidedBy).toBe('human');
      }
    } finally {
      await remove();
    }
  });

  it('refuses to validate without a passing proof', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      const lesson = await candidate(root);
      const outcome = await decideLesson(root, {
        id: lesson.id,
        action: 'validate',
        decidedBy: 'human',
        reason: 'no proof',
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toMatch(/passing eval result/);
    } finally {
      await remove();
    }
  });

  it('refuses to validate with a proof that failed', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      const lesson = await candidate(root);
      const outcome = await decideLesson(root, {
        id: lesson.id,
        action: 'validate',
        decidedBy: 'human',
        reason: 'the proof failed',
        evalResult: result(1, false),
      });
      expect(outcome.ok).toBe(false);
    } finally {
      await remove();
    }
  });

  it('needs three runs for a suite proof', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      const lesson = await candidate(root, 'evals/missing-file');
      const twice = await decideLesson(root, {
        id: lesson.id,
        action: 'validate',
        decidedBy: 'human',
        reason: 'two runs is not three',
        evalResult: result(2),
      });
      expect(twice.ok).toBe(false);
      if (!twice.ok) expect(twice.reason).toMatch(/3 passing runs/);
      const thrice = await decideLesson(root, {
        id: lesson.id,
        action: 'validate',
        decidedBy: 'human',
        reason: 'three runs pass',
        evalResult: result(3),
      });
      expect(thrice.ok).toBe(true);
    } finally {
      await remove();
    }
  });

  it('applies a validated lesson with a change reference', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      const lesson = await candidate(root);
      await decideLesson(root, {
        id: lesson.id,
        action: 'validate',
        decidedBy: 'human',
        reason: 'the proof passes',
        evalResult: result(1),
      });
      const outcome = await decideLesson(root, {
        id: lesson.id,
        action: 'apply',
        decidedBy: 'human',
        reason: 'the change is in',
        changeRef: 'abc1234',
      });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.lesson.state).toBe('applied');
    } finally {
      await remove();
    }
  });

  it('rejects a candidate without a packet', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      const lesson = await candidate(root);
      const outcome = await decideLesson(root, {
        id: lesson.id,
        action: 'reject',
        decidedBy: 'human',
        reason: 'it is not what we want',
      });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.lesson.state).toBe('rejected');
    } finally {
      await remove();
    }
  });

  it('turns an observation of a candidate into a question', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      const lesson = await candidate(root);
      const outcome = await decideLesson(root, {
        id: lesson.id,
        action: 'observe',
        decidedBy: 'human',
        reason: 'the behaviour was the same',
      });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.lesson.state).toBe('open_question');
    } finally {
      await remove();
    }
  });

  it('rolls an applied lesson back when the behaviour did not change', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      const lesson = await candidate(root);
      await decideLesson(root, {
        id: lesson.id,
        action: 'validate',
        decidedBy: 'human',
        reason: 'the proof passes',
        evalResult: result(1),
      });
      await decideLesson(root, {
        id: lesson.id,
        action: 'apply',
        decidedBy: 'human',
        reason: 'the change is in',
        changeRef: 'abc1234',
      });
      const outcome = await decideLesson(root, {
        id: lesson.id,
        action: 'observe',
        decidedBy: 'human',
        reason: 'the behaviour did not change',
      });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.lesson.state).toBe('rolled_back');
    } finally {
      await remove();
    }
  });

  it('supersedes an applied lesson when a newer one took over', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      const lesson = await candidate(root);
      await decideLesson(root, {
        id: lesson.id,
        action: 'validate',
        decidedBy: 'human',
        reason: 'the proof passes',
        evalResult: result(1),
      });
      await decideLesson(root, {
        id: lesson.id,
        action: 'apply',
        decidedBy: 'human',
        reason: 'the change is in',
        changeRef: 'abc1234',
      });
      const outcome = await decideLesson(root, {
        id: lesson.id,
        action: 'observe',
        decidedBy: 'human',
        reason: 'a newer lesson says it better',
        outcome: 'superseded',
      });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.lesson.state).toBe('superseded');
    } finally {
      await remove();
    }
  });

  it('says so when the lesson is not there', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      const outcome = await decideLesson(root, {
        id: 'oa-lesson-nosuch0',
        action: 'reject',
        decidedBy: 'human',
        reason: 'because',
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toMatch(/not there/);
    } finally {
      await remove();
    }
  });

  it('writes the decision into the store', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      const lesson = await candidate(root);
      await decideLesson(root, {
        id: lesson.id,
        action: 'reject',
        decidedBy: 'the person',
        reason: 'it is not what we want',
      });
      const stored = await readLesson(root, lesson.id);
      expect(stored?.state).toBe('rejected');
      expect(stored?.history[0]?.decidedBy).toBe('the person');
    } finally {
      await remove();
    }
  });
});

describe('the proof', () => {
  it('is enough when it passed once for an artifact', () => {
    expect(proofSufficient('lessons/missing-file.json', result(1))).toBe(true);
  });

  it('is not enough when it failed', () => {
    expect(proofSufficient('lessons/missing-file.json', result(1, false))).toBe(false);
    expect(proofSufficient('lessons/missing-file.json', undefined)).toBe(false);
  });

  it('needs three runs for a suite', () => {
    expect(proofSufficient('evals/missing-file', result(2))).toBe(false);
    expect(proofSufficient('evals/missing-file', result(3))).toBe(true);
  });
});
