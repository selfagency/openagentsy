import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureCandidate, SESSION_THRESHOLD } from './capture.js';
import { listLessons, readObservations } from './store.js';

/**
 * A temporary state root.
 */
async function temporaryRoot(): Promise<{ root: string; remove: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'openagentsy-lessons-'));
  return { root, remove: () => rm(root, { recursive: true, force: true }) };
}

/**
 * A secret with the shape of a real one, assembled from segments.
 *
 * The shape is what the redaction looks for, and the segments are what keeps
 * the fixture out of the push protection.
 */
const SECRET = ['gh', 'p_', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('');

/** One sighting of a waste. */
function sighting(session: string, kind = 'missing-file', detail = 'the file was missing') {
  return { kind, detail, session };
}

describe('the capture', () => {
  it('creates no candidate for a waste that has been seen once', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      const outcome = await captureCandidate(root, {
        summary: 'the agent wrote to a file that does not exist',
        observations: [sighting('session-1')],
      });
      expect(outcome.ok).toBe(false);
      expect(await listLessons(root)).toHaveLength(0);
    } finally {
      await remove();
    }
  });

  it('creates a candidate when the same waste shows up in three sessions', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      for (const session of ['session-1', 'session-2']) {
        const outcome = await captureCandidate(root, {
          summary: 'the agent wrote to a file that does not exist',
          observations: [sighting(session)],
        });
        expect(outcome.ok).toBe(false);
      }
      const outcome = await captureCandidate(root, {
        summary: 'the agent wrote to a file that does not exist',
        observations: [sighting('session-3')],
      });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.created).toBe(true);
        expect(outcome.lesson.state).toBe('candidate');
        expect(outcome.lesson.sessions).toHaveLength(SESSION_THRESHOLD);
      }
      expect(await listLessons(root)).toHaveLength(1);
    } finally {
      await remove();
    }
  });

  it('counts a waste of another kind as another waste', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      for (const session of ['session-1', 'session-2', 'session-3']) {
        await captureCandidate(root, {
          summary: 'the agent wrote to a file that does not exist',
          observations: [sighting(session)],
        });
      }
      const outcome = await captureCandidate(root, {
        summary: 'the test suite took a minute',
        observations: [sighting('session-4', 'slow-test', 'the test took a minute')],
      });
      expect(outcome.ok).toBe(false);
      expect(await listLessons(root)).toHaveLength(1);
    } finally {
      await remove();
    }
  });

  it('creates a candidate at once for an explicit correction', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      const outcome = await captureCandidate(root, {
        summary: 'the person said the agent must read the file first',
        observations: [sighting('session-1')],
        explicitCorrection: true,
      });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.created).toBe(true);
    } finally {
      await remove();
    }
  });

  it('deduplicates by the normalised summary and raises the count', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      const first = await captureCandidate(root, {
        summary: 'The agent wrote to a file that does not exist.',
        observations: [sighting('session-1')],
        explicitCorrection: true,
      });
      expect(first.ok).toBe(true);
      const second = await captureCandidate(root, {
        summary: 'the agent wrote to a file that does not exist',
        observations: [sighting('session-2')],
        explicitCorrection: true,
      });
      expect(second.ok).toBe(true);
      if (first.ok && second.ok) {
        expect(second.created).toBe(false);
        expect(second.lesson.id).toBe(first.lesson.id);
        expect(second.lesson.occurrences).toBe(2);
      }
      expect(await listLessons(root)).toHaveLength(1);
    } finally {
      await remove();
    }
  });

  it('keeps the observations, so the third session can be a pattern', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      await captureCandidate(root, {
        summary: 'the agent wrote to a file that does not exist',
        observations: [sighting('session-1')],
      });
      expect(await readObservations(root)).toHaveLength(1);
    } finally {
      await remove();
    }
  });

  it('keeps a secret out of the store, in the summary and in the detail', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      const outcome = await captureCandidate(root, {
        summary: `the token ${SECRET} was pasted into the file`,
        observations: [sighting('session-1', 'secret', `the token was ${SECRET}`)],
        explicitCorrection: true,
        evidence: [`the run used ${SECRET}`],
      });
      expect(outcome.ok).toBe(true);
      const stored = await readFile(
        join(root, '.openagentsy', 'lessons', `${outcome.ok ? outcome.lesson.id : ''}.json`),
        'utf8',
      );
      expect(stored).not.toContain(SECRET);
      expect(stored).toContain('redacted:github-token');
      const observations = await readFile(
        join(root, '.openagentsy', 'lessons', 'observations.json'),
        'utf8',
      );
      expect(observations).not.toContain(SECRET);
    } finally {
      await remove();
    }
  });
});
