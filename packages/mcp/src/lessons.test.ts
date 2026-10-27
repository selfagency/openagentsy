import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLessonTools, LESSON_TOOL_NAMES, type LessonToolResult } from './lessons.js';

async function stateRoot(): Promise<{ root: string; remove: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'openagentsy-mcp-lessons-'));
  return { root, remove: () => rm(root, { recursive: true, force: true }) };
}

/** What a tool answered with. */
function payload(result: LessonToolResult): Record<string, unknown> {
  const text = result.content[0]?.text ?? '{}';
  return JSON.parse(text) as Record<string, unknown>;
}

describe('the lesson tools', () => {
  it('names the two tools', () => {
    expect(LESSON_TOOL_NAMES).toEqual(['oa_lesson_propose', 'oa_lesson_decide']);
  });

  it('says a waste seen once is not a pattern', async () => {
    const { root, remove } = await stateRoot();
    try {
      const tools = createLessonTools(root);
      const result = await tools.oa_lesson_propose.handler({
        summary: 'the agent wrote to a file that does not exist',
        kind: 'missing-file',
        detail: 'the file was missing',
        session: 'session-1',
      });
      const body = payload(result);
      expect(body.created).toBe(false);
      expect(body.reason).toBe('not_enough_sessions');
    } finally {
      await remove();
    }
  });

  it('creates a candidate when the waste shows up in three sessions', async () => {
    const { root, remove } = await stateRoot();
    try {
      const tools = createLessonTools(root);
      const results: LessonToolResult[] = [];
      for (const session of ['session-1', 'session-2', 'session-3']) {
        results.push(
          await tools.oa_lesson_propose.handler({
            summary: 'the agent wrote to a file that does not exist',
            kind: 'missing-file',
            detail: 'the file was missing',
            session,
          }),
        );
      }
      const third = results[2];
      expect(third).toBeDefined();
      const body = payload(third as LessonToolResult);
      expect(body.created).toBe(true);
      expect(body.state).toBe('candidate');
    } finally {
      await remove();
    }
  });

  it('refuses an owner that is not an owner', async () => {
    const { root, remove } = await stateRoot();
    try {
      const tools = createLessonTools(root);
      const result = await tools.oa_lesson_propose.handler({
        summary: 'the agent wrote to a file that does not exist',
        kind: 'missing-file',
        detail: 'the file was missing',
        session: 'session-1',
        owner: 'the codebase',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/is not an owner/);
    } finally {
      await remove();
    }
  });

  it('records the decision of a person', async () => {
    const { root, remove } = await stateRoot();
    try {
      const tools = createLessonTools(root);
      const proposed = await tools.oa_lesson_propose.handler({
        summary: 'the person said the agent must read the file first',
        kind: 'missing-file',
        detail: 'the file was missing',
        session: 'session-1',
        explicitCorrection: true,
      });
      const id = payload(proposed).id;
      expect(typeof id).toBe('string');

      const decided = await tools.oa_lesson_decide.handler({
        id: id as string,
        action: 'reject',
        decidedBy: 'the person',
        reason: 'it is not what we want',
      });
      const body = payload(decided);
      expect(body.state).toBe('rejected');
    } finally {
      await remove();
    }
  });

  it('refuses to validate without a proof', async () => {
    const { root, remove } = await stateRoot();
    try {
      const tools = createLessonTools(root);
      const proposed = await tools.oa_lesson_propose.handler({
        summary: 'the person said the agent must read the file first',
        kind: 'missing-file',
        detail: 'the file was missing',
        session: 'session-1',
        explicitCorrection: true,
        owner: 'test:missing-file',
        futureBehavior: 'read the file before writing to it',
        representativeTask: 'the agent writes to a file that does not exist',
        writeBoundary: ['packages/hooks/src/**'],
        proof: 'lessons/missing-file.json',
      });
      const id = payload(proposed).id;
      const decided = await tools.oa_lesson_decide.handler({
        id: id as string,
        action: 'validate',
        decidedBy: 'the person',
        reason: 'no proof yet',
      });
      expect(decided.isError).toBe(true);
      expect(decided.content[0]?.text).toMatch(/passing eval result/);
    } finally {
      await remove();
    }
  });
});
