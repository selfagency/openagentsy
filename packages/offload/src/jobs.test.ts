import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  classify,
  compactionSummary,
  quickReplies,
  repairToolArguments,
  titleFor,
} from './jobs.js';
import { startStubServer } from './test-support/http.js';
import type { LocalBackend } from './types.js';

const backend = (baseUrl: string): LocalBackend => ({ kind: 'ollama', baseUrl, model: 'llama3' });

/** A stub that answers with whatever the test set last. */
async function withAnswers<T>(
  answers: T,
  run: (backend: LocalBackend) => Promise<void>,
): Promise<void> {
  const current = answers;
  const server = await startStubServer(() => ({
    body: JSON.stringify({ message: { content: JSON.stringify(current) } }),
  }));
  try {
    await run(backend(server.baseUrl));
  } finally {
    server.close();
  }
}

describe('the housekeeping jobs', () => {
  it('returns a title that fits the bound', async () => {
    await withAnswers({ title: 'A short title' }, async (be) => {
      expect(await titleFor('a long conversation', be, () => undefined)).toEqual({
        title: 'A short title',
      });
    });
  });

  it('rejects a title over 60 characters', async () => {
    await withAnswers({ title: 'x'.repeat(61) }, async (be) => {
      expect(await titleFor('a long conversation', be, () => undefined)).toBeUndefined();
    });
  });

  it('rejects a summary over 1200 characters', async () => {
    await withAnswers({ summary: 'x'.repeat(1201), keep: [] }, async (be) => {
      expect(await compactionSummary('a long context', be, () => undefined)).toBeUndefined();
    });
  });

  it('keeps the facts to keep beside the summary', async () => {
    await withAnswers({ summary: 'a short summary', keep: ['the deadline'] }, async (be) => {
      expect(await compactionSummary('a long context', be, () => undefined)).toEqual({
        summary: 'a short summary',
        keep: ['the deadline'],
      });
    });
  });

  it('rejects more than four quick replies', async () => {
    await withAnswers({ replies: ['one', 'two', 'three', 'four', 'five'] }, async (be) => {
      expect(await quickReplies('the last turn', be, () => undefined)).toBeUndefined();
    });
  });

  it('keeps four quick replies', async () => {
    await withAnswers({ replies: ['one', 'two', 'three', 'four'] }, async (be) => {
      expect(await quickReplies('the last turn', be, () => undefined)).toEqual({
        replies: ['one', 'two', 'three', 'four'],
      });
    });
  });

  it('rejects a quick reply over ten words', async () => {
    await withAnswers(
      { replies: ['one two three four five six seven eight nine ten eleven'] },
      async (be) => {
        expect(await quickReplies('the last turn', be, () => undefined)).toBeUndefined();
      },
    );
  });

  it('classifies into one of the given values', async () => {
    await withAnswers({ label: 'bug' }, async (be) => {
      expect(await classify('it crashes on start', ['bug', 'feature'], be, () => undefined)).toBe(
        'bug',
      );
    });
  });

  it('refuses a label that is not one of the given values', async () => {
    await withAnswers({ label: 'other' }, async (be) => {
      expect(
        await classify('it crashes on start', ['bug', 'feature'], be, () => undefined),
      ).toBeUndefined();
    });
  });

  it('repairs tool arguments into the target schema', async () => {
    const schema = z.object({ path: z.string(), line: z.number() });
    await withAnswers({ path: 'src/index.ts', line: 12 }, async (be) => {
      expect(
        await repairToolArguments(
          '{"path": "src/index.ts", "line": 12',
          schema,
          be,
          () => undefined,
        ),
      ).toEqual({
        path: 'src/index.ts',
        line: 12,
      });
    });
  });

  it('returns nothing when the backend is unreachable', async () => {
    const server = await startStubServer(() => ({ body: '{}' }));
    const baseUrl = server.baseUrl;
    server.close();
    expect(
      await titleFor('a long conversation', backend(baseUrl), () => undefined),
    ).toBeUndefined();
  });

  it('reports the usage of a job that worked', async () => {
    const server = await startStubServer(() => ({
      body: JSON.stringify({
        message: { content: '{"title":"Hello"}' },
        prompt_eval_count: 3,
        eval_count: 4,
      }),
    }));
    try {
      const usage: { job: string; seconds: number; inTok: number; outTok: number }[] = [];
      await titleFor('a long conversation', backend(server.baseUrl), (u) => usage.push(u));
      expect(usage).toEqual([{ job: 'title', seconds: expect.any(Number), inTok: 3, outTok: 4 }]);
    } finally {
      server.close();
    }
  });
});
