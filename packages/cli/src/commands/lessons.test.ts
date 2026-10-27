import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureCandidate } from '@openagentsy/hooks';
import { describe, expect, it } from 'vitest';
import {
  deciderBy,
  formatLessonDecision,
  formatLessonsReport,
  runLessonDecision,
  runLessons,
} from './lessons.js';

async function stateRoot(): Promise<{ root: string; remove: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'openagentsy-cli-lessons-'));
  return { root, remove: () => rm(root, { recursive: true, force: true }) };
}

/** A candidate waiting for a decision. */
async function candidate(root: string, summary: string, session: string) {
  const outcome = await captureCandidate(root, {
    summary,
    observations: [{ kind: 'missing-file', detail: 'the file was missing', session }],
    explicitCorrection: true,
  });
  if (!outcome.ok) throw new Error('the candidate was not created');
  return outcome.lesson;
}

describe('the lessons inbox', () => {
  it('lists the lessons that are waiting for a person', async () => {
    const { root, remove } = await stateRoot();
    try {
      await candidate(root, 'the agent wrote to a file that does not exist', 'session-1');
      const report = await runLessons(root);
      expect(report.awaiting).toBe(1);
      expect(report.lessons[0]?.summary).toBe('the agent wrote to a file that does not exist');
      expect(report.lessons[0]?.occurrences).toBe(1);
    } finally {
      await remove();
    }
  });

  it('sorts the inbox by occurrences and then by recency', async () => {
    const { root, remove } = await stateRoot();
    try {
      await candidate(root, 'the first lesson', 'session-1');
      await candidate(root, 'the second lesson', 'session-2');
      await captureCandidate(root, {
        summary: 'the first lesson',
        observations: [{ kind: 'missing-file', detail: 'the file was missing', session: 's' }],
        explicitCorrection: true,
      });
      const report = await runLessons(root);
      expect(report.lessons[0]?.summary).toBe('the first lesson');
      expect(report.lessons[0]?.occurrences).toBe(2);
    } finally {
      await remove();
    }
  });

  it('says when there is nothing to decide', async () => {
    const { root, remove } = await stateRoot();
    try {
      const report = await runLessons(root);
      expect(report.awaiting).toBe(0);
      expect(formatLessonsReport(report)).toContain('none');
    } finally {
      await remove();
    }
  });

  it('reads the inbox as a table', async () => {
    const { root, remove } = await stateRoot();
    try {
      await candidate(root, 'the agent wrote to a file that does not exist', 'session-1');
      const text = formatLessonsReport(await runLessons(root));
      expect(text).toContain('1 awaiting a decision');
      expect(text).toContain('the agent wrote to a file that does not exist');
    } finally {
      await remove();
    }
  });
});

describe('the lesson decision', () => {
  it('records the decision and names the person', async () => {
    const { root, remove } = await stateRoot();
    try {
      const lesson = await candidate(root, 'the first lesson', 'session-1');
      const report = await runLessonDecision(root, lesson.id, 'reject', {
        decidedBy: 'the person',
        reason: 'it is not what we want',
      });
      expect(report.ok).toBe(true);
      expect(report.state).toBe('rejected');
      expect(formatLessonDecision(report)).toContain('is now rejected');
    } finally {
      await remove();
    }
  });

  it('decides for a person when nobody says who', async () => {
    const { root, remove } = await stateRoot();
    try {
      const lesson = await candidate(root, 'the first lesson', 'session-1');
      const report = await runLessonDecision(root, lesson.id, 'reject');
      expect(report.ok).toBe(true);
      expect(deciderBy()).toBe('human');
    } finally {
      await remove();
    }
  });

  it('refuses an action that is not one of the four', async () => {
    const { root, remove } = await stateRoot();
    try {
      const lesson = await candidate(root, 'the first lesson', 'session-1');
      const report = await runLessonDecision(root, lesson.id, 'obliterate');
      expect(report.ok).toBe(false);
      expect(report.reason).toMatch(/unknown lesson action/);
      expect(formatLessonDecision(report)).toContain('Next:');
    } finally {
      await remove();
    }
  });

  it('says so when the lesson is not there', async () => {
    const { root, remove } = await stateRoot();
    try {
      const report = await runLessonDecision(root, 'oa-lesson-nosuch0', 'reject');
      expect(report.ok).toBe(false);
      expect(report.reason).toMatch(/not there/);
    } finally {
      await remove();
    }
  });
});
