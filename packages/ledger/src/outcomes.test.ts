import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeLedger, openLedger } from './db.js';
import { runGit } from './git.js';
import { recordAssistantMessage } from './ingest.js';
import { recordOutcome, scanRefsTrailers, scanTaskTransitions } from './outcomes.js';
import { tokensPerCommit, tokensPerCompletedTask, tokensPerResult } from './query.js';
import type { OutcomeKind } from './schema.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openagentsy-outcomes-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('the outcome recorder', () => {
  it('writes the outcome once', () => {
    const db = openLedger(root);
    try {
      expect(recordOutcome(db, { kind: 'task_completed', taskId: 'task-1' })).toBe(true);
      expect(recordOutcome(db, { kind: 'task_completed', taskId: 'task-1' })).toBe(false);
      const rows = db.query('SELECT COUNT(*) AS count FROM outcome').get() as { count: number };
      expect(rows.count).toBe(1);
    } finally {
      closeLedger(db);
    }
  });

  it('refuses a kind the schema does not know', () => {
    const db = openLedger(root);
    try {
      expect(() => recordOutcome(db, { kind: 'nonsense' as unknown as OutcomeKind })).toThrow(
        /unknown outcome kind/,
      );
    } finally {
      closeLedger(db);
    }
  });

  it('keeps the task and the commit of an outcome', () => {
    const db = openLedger(root);
    try {
      recordOutcome(db, {
        kind: 'commit',
        taskId: 'task-1',
        commitSha: 'abc1234',
        rootSessionId: 'ses_root',
      });
      const row = db
        .query('SELECT kind, task_id, commit_sha, root_session_id FROM outcome')
        .get() as {
        kind: string;
        task_id: string;
        commit_sha: string;
        root_session_id: string;
      };
      expect(row.kind).toBe('commit');
      expect(row.task_id).toBe('task-1');
      expect(row.commit_sha).toBe('abc1234');
      expect(row.root_session_id).toBe('ses_root');
    } finally {
      closeLedger(db);
    }
  });
});

describe('the refs trailer scanner', () => {
  it('finds the commits that name a task', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'openagentsy-repo-'));
    await seedRepo(repo);

    const outcomes = scanRefsTrailers(repo, '30 days ago');

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.kind).toBe('commit');
    expect(outcomes[0]?.taskId).toBe('task-1');
    expect(outcomes[0]?.commitSha).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('the task transition scanner', () => {
  it('turns the finished tasks into outcomes', async () => {
    const outcomes = await scanTaskTransitions('/beans', '2026-01-01T00:00:00.000Z', async () => [
      { id: 'task-1', status: 'completed', updated_at: '2026-01-02T00:00:00.000Z' },
      { id: 'task-2', status: 'scrapped', updated_at: '2026-01-02T00:00:00.000Z' },
      { id: 'task-3', status: 'in-progress', updated_at: '2026-01-02T00:00:00.000Z' },
    ]);

    expect(outcomes).toHaveLength(2);
    expect(outcomes.find((outcome) => outcome.taskId === 'task-1')?.kind).toBe('task_completed');
    expect(outcomes.find((outcome) => outcome.taskId === 'task-2')?.kind).toBe('task_scrapped');
  });

  it('leaves the tasks that finished before the window alone', async () => {
    const outcomes = await scanTaskTransitions('/beans', '2026-02-01T00:00:00.000Z', async () => [
      { id: 'task-1', status: 'completed', updated_at: '2026-01-02T00:00:00.000Z' },
    ]);

    expect(outcomes).toHaveLength(0);
  });

  it('reads the store through the reader it is given', async () => {
    const seen: string[] = [];
    await scanTaskTransitions('/beans', '2026-01-01T00:00:00.000Z', async (root) => {
      seen.push(root);
      return [];
    });

    expect(seen).toEqual(['/beans']);
  });
});

describe('the outcome joins', () => {
  it('counts the tokens of a completed task', () => {
    const db = openLedger(root);
    try {
      recordAssistantMessage(
        db,
        {
          id: 'm1',
          sessionID: 'ses_1',
          providerID: 'anthropic',
          modelID: 'claude-sonnet-4-5',
          tokens: { input: 100, output: 40, reasoning: 10, cache: { write: 5 } },
        },
        {
          rootSessionId: 'ses_1',
          role: 'builder',
          activeTaskId: 'task-1',
          ts: '2026-01-02T00:00:00.000Z',
        },
      );
      recordOutcome(db, { kind: 'task_completed', taskId: 'task-1' });

      const rows = tokensPerCompletedTask(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.taskId).toBe('task-1');
      expect(rows[0]?.tokens).toBe(155);

      recordOutcome(db, { kind: 'commit', taskId: 'task-1', commitSha: 'abc1234' });
      const commits = tokensPerCommit(db);
      expect(commits).toHaveLength(1);
      expect(commits[0]?.commitSha).toBe('abc1234');
      expect(commits[0]?.tokens).toBe(155);

      const result = tokensPerResult(db);
      expect(result.tasksCompleted).toBe(1);
      expect(result.tokensPerTask).toBe(155);
      expect(result.commits).toBe(1);
    } finally {
      closeLedger(db);
    }
  });
});

/** A repository with one commit that names a task and one that does not. */
async function seedRepo(repo: string): Promise<void> {
  const git = (...args: string[]): void => {
    const result = runGit(repo, [
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=Test',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ]);
    if (!result.ok) throw new Error(result.stderr);
  };
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');

  await writeFile(join(repo, 'a.txt'), 'one\n');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'feat: add\n\nRefs: task-1');

  await writeFile(join(repo, 'b.txt'), 'two\n');
  git('add', 'b.txt');
  git('commit', '-q', '-m', 'chore: add');
}
