import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hashOf } from '../eval/runner.js';
import { captureCandidate } from './capture.js';
import { decideLesson, proofSufficient } from './decide.js';
import type { EvalResult, StartPacket } from './model.js';
import { readLesson } from './store.js';

async function temporaryRoot(): Promise<{ root: string; remove: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'openagentsy-decide-'));
  return { root, remove: () => rm(root, { recursive: true, force: true }) };
}

/** A packet that says everything it has to say. */
function completePacket(proof: string): Partial<StartPacket> {
  return {
    futureBehavior: 'read the file before writing to it',
    representativeTask: 'the agent writes to a file that does not exist',
    evidence: ['session-1'],
    owner: 'test:missing-file',
    writeBoundary: ['packages/hooks/src/**'],
    proof,
  };
}

/**
 * A proof that passes, and the name of the file it is in.
 *
 * The proof is an artifact the runner can run, so the decision has a real
 * verdict to rest on.
 */
async function proofArtifact(root: string, name = 'proof.json'): Promise<string> {
  const script = join(root, 'ok.js');
  await writeFile(script, 'console.log("ok");\n', 'utf8');
  await writeFile(
    join(root, name),
    JSON.stringify({
      schema_version: '1',
      lesson_id: 'oa-lesson-proof01',
      name: 'the proof',
      scenarios: [
        {
          id: 's',
          phase: 'candidate',
          cwd: '.',
          command: [process.execPath, script],
          expect: { stdout_includes: ['ok'] },
        },
      ],
    }),
    'utf8',
  );
  return name;
}

/** The hash of a proof file. */
async function proofHash(root: string, name: string): Promise<string> {
  return hashOf(await readFile(join(root, name), 'utf8'));
}

/** A result, built by hand. */
function result(lessonId: string, artifactSha: string, runs = 1, passed = true): EvalResult {
  return {
    schema_version: '1',
    lesson_id: lessonId,
    artifact_sha256: artifactSha,
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
    packet: completePacket(proof),
  });
  if (!outcome.ok) throw new Error('the candidate was not created');
  return outcome.lesson;
}

describe('the decision', () => {
  it('validates a candidate whose proof runs and passes', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      const proof = await proofArtifact(root);
      const lesson = await candidate(root, proof);
      const outcome = await decideLesson(root, {
        id: lesson.id,
        action: 'validate',
        decidedBy: 'human',
        reason: 'the proof passes',
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

  it('refuses to validate a candidate whose proof does not pass', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      await writeFile(join(root, 'bad.js'), 'console.log("nope");\n', 'utf8');
      await writeFile(
        join(root, 'bad.json'),
        JSON.stringify({
          schema_version: '1',
          lesson_id: 'oa-lesson-proof01',
          name: 'the proof',
          scenarios: [
            {
              id: 's',
              phase: 'candidate',
              cwd: '.',
              command: [process.execPath, join(root, 'bad.js')],
              expect: { stdout_includes: ['ok'] },
            },
          ],
        }),
        'utf8',
      );
      const lesson = await candidate(root, 'bad.json');
      const outcome = await decideLesson(root, {
        id: lesson.id,
        action: 'validate',
        decidedBy: 'human',
        reason: 'the proof fails',
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toMatch(/did not pass/);
    } finally {
      await remove();
    }
  });

  it('refuses a result whose verdicts disagree with its assertions', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      const proof = await proofArtifact(root);
      const lesson = await candidate(root, proof);
      const handWritten: EvalResult = {
        schema_version: '1',
        lesson_id: lesson.id,
        artifact_sha256: await proofHash(root, proof),
        started_at: '2026-10-27T00:00:00.000Z',
        finished_at: '2026-10-27T00:00:01.000Z',
        passed: true,
        runs: 1,
        scenarios: [
          {
            id: 's',
            phase: 'candidate',
            command_sha256: 'a'.repeat(64),
            exit_code: 0,
            timed_out: false,
            duration_ms: 1,
            assertions: { exit_code: false },
            passed: true,
          },
        ],
      };
      const outcome = await decideLesson(root, {
        id: lesson.id,
        action: 'validate',
        decidedBy: 'human',
        reason: 'a result a person wrote',
        evalResult: handWritten,
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toMatch(/disagrees with its assertions/);
    } finally {
      await remove();
    }
  });

  it('refuses a result that is about another lesson', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      const proof = await proofArtifact(root);
      const lesson = await candidate(root, proof);
      const outcome = await decideLesson(root, {
        id: lesson.id,
        action: 'validate',
        decidedBy: 'human',
        reason: 'a result about another lesson',
        evalResult: result('oa-lesson-other00', await proofHash(root, proof)),
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toMatch(/not about this lesson/);
    } finally {
      await remove();
    }
  });

  it('refuses a result that does not match the proof', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      const proof = await proofArtifact(root);
      const lesson = await candidate(root, proof);
      const outcome = await decideLesson(root, {
        id: lesson.id,
        action: 'validate',
        decidedBy: 'human',
        reason: 'a result from another run',
        evalResult: result(lesson.id, 'b'.repeat(64)),
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toMatch(/does not match the proof/);
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
        evalResult: result(lesson.id, 'a'.repeat(64), 2),
      });
      expect(twice.ok).toBe(false);
      if (!twice.ok) expect(twice.reason).toMatch(/3 passing runs/);
      const thrice = await decideLesson(root, {
        id: lesson.id,
        action: 'validate',
        decidedBy: 'human',
        reason: 'three runs pass',
        evalResult: result(lesson.id, 'a'.repeat(64), 3),
      });
      expect(thrice.ok).toBe(true);
    } finally {
      await remove();
    }
  });

  it('applies a validated lesson with a change reference', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      const proof = await proofArtifact(root);
      const lesson = await candidate(root, proof);
      await decideLesson(root, {
        id: lesson.id,
        action: 'validate',
        decidedBy: 'human',
        reason: 'the proof passes',
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
      const proof = await proofArtifact(root);
      const lesson = await candidate(root, proof);
      await decideLesson(root, {
        id: lesson.id,
        action: 'validate',
        decidedBy: 'human',
        reason: 'the proof passes',
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
      const proof = await proofArtifact(root);
      const lesson = await candidate(root, proof);
      await decideLesson(root, {
        id: lesson.id,
        action: 'validate',
        decidedBy: 'human',
        reason: 'the proof passes',
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

  it('keeps a secret out of the decision and the session', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      const secret = ['gh', 'p_', 'b'.repeat(36)].join('');
      const outcome = await captureCandidate(root, {
        summary: 'the person corrected the agent',
        observations: [
          { kind: 'missing-file', detail: 'the file was missing', session: `session-${secret}` },
        ],
        explicitCorrection: true,
      });
      if (!outcome.ok) throw new Error('the candidate was not created');
      await decideLesson(root, {
        id: outcome.lesson.id,
        action: 'reject',
        decidedBy: 'human',
        reason: `the run used ${secret}`,
      });
      const lesson = await readFile(
        join(root, '.openagentsy', 'lessons', `${outcome.lesson.id}.json`),
        'utf8',
      );
      expect(lesson).not.toContain(secret);
      expect(lesson).toContain('redacted:github-token');
      const observations = await readFile(
        join(root, '.openagentsy', 'lessons', 'observations.json'),
        'utf8',
      );
      expect(observations).not.toContain(secret);
    } finally {
      await remove();
    }
  });
});

describe('the proof', () => {
  it('is enough when it passed once for an artifact', () => {
    expect(proofSufficient('lessons/missing-file.json', result('oa-lesson-a', 'a'))).toBe(true);
  });

  it('is not enough when it failed', () => {
    expect(proofSufficient('lessons/missing-file.json', result('oa-lesson-a', 'a', 1, false))).toBe(
      false,
    );
    expect(proofSufficient('lessons/missing-file.json', undefined)).toBe(false);
  });

  it('needs three runs for a suite', () => {
    expect(proofSufficient('evals/missing-file', result('oa-lesson-a', 'a', 2))).toBe(false);
    expect(proofSufficient('evals/missing-file', result('oa-lesson-a', 'a', 3))).toBe(true);
  });
});
