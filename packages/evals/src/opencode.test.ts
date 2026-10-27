import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpencodeClient } from '@opencode-ai/sdk';
import { describe, expect, it } from 'vitest';

import {
  attributeHostErrors,
  HARNESS_SWEEP_AGE_MS,
  hostErrorsIn,
  hostFaults,
  killSessionWhenItAppears,
  readHostErrors,
  removeHarnessFiles,
  replyPartsOf,
  serveArgs,
  sweepStaleHarnessFiles,
} from './opencode.js';

describe('replyPartsOf', () => {
  it('reads the text of the last assistant message', () => {
    const { text } = replyPartsOf([
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'the question' }] },
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'the answer' }] },
    ]);
    expect(text).toBe('the answer');
  });

  it('reads the tool calls of the last assistant message', () => {
    const { toolCalls } = replyPartsOf([
      {
        info: { role: 'assistant' },
        parts: [{ type: 'tool', tool: 'edit', state: { input: { filePath: 'src/app.ts' } } }],
      },
    ]);
    expect(toolCalls).toEqual([{ tool: 'edit', input: { filePath: 'src/app.ts' } }]);
  });

  it('takes the reply that came after a rate limit', () => {
    // The provider refused the turn, then the turn was asked again and the
    // agent answered. The reply is the answer, not the refusal.
    const { text } = replyPartsOf([
      {
        info: { role: 'assistant', error: { data: { statusCode: 429 } } },
        parts: [{ type: 'text', text: 'rate limited' }],
      },
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'the real answer' }] },
    ]);
    expect(text).toBe('the real answer');
  });

  it('returns nothing for an empty session', () => {
    expect(replyPartsOf([])).toEqual({ text: '', toolCalls: [] });
  });

  it('skips the synthetic message a climb leaves behind', () => {
    // The model switch is a message of its own, and it carries no reply.
    // Taking the last message lost the reply, and the case looked like the
    // agent had said nothing.
    const { text } = replyPartsOf([
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'the answer' }] },
      {
        info: { role: 'assistant' },
        parts: [
          {
            type: 'text',
            text: 'effort ladder: model high',
            synthetic: true,
            ignored: true,
          },
        ],
      },
    ]);
    expect(text).toBe('the answer');
  });
});

const INFO_LINE = 'timestamp=2026-10-24T12:00:00.000Z level=INFO message=loop session.id=ses_a\n';

/** The line shape measured in a real server log, with `session.id=`. */
const ERROR_BLOCK = [
  'timestamp=2026-10-15T01:48:26.213Z level=ERROR run=8f8d2e90 message="stream error" providerID=opencode-go modelID=glm-5.3-flash session.id=ses_ec7e1725dffetH2YmTqboowL6x small=false agent=OpenCoder mode=primary error.error="AI_APICallError: Upstream request failed"',
  'EffectDrizzleQueryError: insert into message',
  'FOREIGN KEY constraint failed',
].join('\n');

/**
 * The ERROR the server wrote when the harness aborted a session on purpose.
 *
 * Measured on 2026-10-24 in `fault builder killed`: the case kills the
 * builder mid-turn, and the abort is the fault the case injected.
 */
const KILLED_ERROR_BLOCK =
  'timestamp=2026-10-24T17:28:21.450Z level=ERROR run=c09f37f0 message=process session.id=ses_e910b2c07ffepW3IvLHGdkxrnz messageID=msg_16ef4d406001j75YtQzFodz84w error=Aborted stack=undefined';

/** The same abort line, against any session. */
function abortBlock(sessionID: string): string {
  return `timestamp=2026-10-24T17:28:21.450Z level=ERROR run=c09f37f0 message=process session.id=${sessionID} messageID=msg_16ef4d406001j75YtQzFodz84w error=Aborted stack=undefined`;
}

/**
 * The line shape measured in a real server log.
 *
 * The server names the session `sessionID=`, not `session.id=`, and that is
 * the shape an ERROR that actually happened carried.
 */
const MEASURED_ERROR_BLOCK = [
  'timestamp=2026-10-24T16:20:41.653Z level=ERROR run=85cfe08a message="prompt_async failed" sessionID=ses_e9149bf61ffeS2Ch6pW4AAuClk cause="Cause([Die(EffectDrizzleQueryError: Failed query: insert into "message" ...',
  'EffectDrizzleQueryError: insert into message',
  'FOREIGN KEY constraint failed',
].join('\n');

describe('serveArgs', () => {
  it('asks the server to print its structured logs to stderr, which the harness reads', () => {
    // Without --print-logs the ERROR lines go to the app log and the file the
    // harness reads stays free of them, so a host fault cannot fail the suite.
    expect(serveArgs(40_123)).toEqual([
      'serve',
      '--port',
      '40123',
      '--hostname',
      '127.0.0.1',
      '--print-logs',
    ]);
  });
});

describe('harness files', () => {
  it('deletes the database, its sidecars and the log it named on stop', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openagentsy-harness-files-'));
    const database = join(dir, 'openagentsy-eval-40123.db');
    const log = join(dir, 'openagentsy-eval-server-40123.log');
    try {
      for (const file of [database, `${database}-shm`, `${database}-wal`, log]) {
        await writeFile(file, 'x', 'utf8');
      }

      const removed = await removeHarnessFiles(database, log);

      expect(removed).toHaveLength(4);
      for (const file of [database, `${database}-shm`, `${database}-wal`, log]) {
        await expect(stat(file)).rejects.toThrow();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('leaves a log the caller named', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openagentsy-harness-files-'));
    const database = join(dir, 'openagentsy-eval-40124.db');
    const log = join(dir, 'caller.log');
    try {
      await writeFile(database, 'x', 'utf8');
      await writeFile(log, 'x', 'utf8');

      // No log argument: the path was not the harness's to remove.
      await removeHarnessFiles(database);

      await expect(stat(database)).rejects.toThrow();
      expect((await stat(log)).isFile()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('sweeps a stale file and leaves a fresh one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openagentsy-harness-sweep-'));
    const stale = join(dir, 'openagentsy-eval-40001.db');
    const fresh = join(dir, 'openagentsy-eval-40002.log');
    const foreign = join(dir, 'notes.txt');
    try {
      for (const file of [stale, fresh, foreign]) await writeFile(file, 'x', 'utf8');
      const now = Date.now();
      const old = new Date(now - HARNESS_SWEEP_AGE_MS - 60_000);
      await utimes(stale, old, old);
      await utimes(foreign, old, old);

      const removed = await sweepStaleHarnessFiles(dir, now);

      expect(removed).toContain(stale);
      await expect(stat(stale)).rejects.toThrow();
      // A run that is still going on keeps its file, and a file that is not
      // ours is never in the list.
      expect((await stat(fresh)).isFile()).toBe(true);
      expect((await stat(foreign)).isFile()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('host errors', () => {
  it('keeps an error block with its continuation lines and its session', () => {
    const errors = hostErrorsIn(`${INFO_LINE}${ERROR_BLOCK}\n${INFO_LINE}`);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.sessionID).toBe('ses_ec7e1725dffetH2YmTqboowL6x');
    // The stack is the reason, so dropping the continuation would drop why.
    expect(errors[0]?.line).toContain('FOREIGN KEY constraint failed');
  });

  it('does not treat a line the server wrote at INFO as a fault', () => {
    expect(hostErrorsIn(INFO_LINE)).toEqual([]);
  });

  it('attributes an error to the case that owns the session it names', () => {
    const [error] = attributeHostErrors(
      hostErrorsIn(ERROR_BLOCK),
      new Map([['ses_ec7e1725dffetH2YmTqboowL6x', 'scope push']]),
    );
    expect(error?.case).toBe('scope push');
  });

  it('reads the measured line shape, sessionID, and attributes it to its case', () => {
    const [error] = attributeHostErrors(
      hostErrorsIn(MEASURED_ERROR_BLOCK),
      new Map([['ses_e9149bf61ffeS2Ch6pW4AAuClk', 'scope push']]),
    );
    expect(error?.sessionID).toBe('ses_e9149bf61ffeS2Ch6pW4AAuClk');
    expect(error?.case).toBe('scope push');
    expect(error?.line).toContain('EffectDrizzleQueryError');
  });

  it('surfaces an error naming a session it never tracked, attributed to the suite', () => {
    // A plugin-created child (the archivist) is never registered with
    // trackSession, and its error must still fail the suite, not vanish.
    const errors = attributeHostErrors(
      hostErrorsIn(MEASURED_ERROR_BLOCK),
      new Map([['ses_other', 'scope push']]),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.case).toBe('the suite');
    expect(errors[0]?.sessionID).toBe('ses_e9149bf61ffeS2Ch6pW4AAuClk');
  });

  it('attributes an error it cannot place to the suite rather than dropping it', () => {
    const [error] = attributeHostErrors(hostErrorsIn(ERROR_BLOCK), new Map());
    expect(error?.case).toBe('the suite');
  });

  it('reads only what was appended after the offset, which is what a case owns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openagentsy-host-errors-'));
    const log = join(root, 'server.log');
    try {
      await writeFile(log, INFO_LINE, 'utf8');
      // The offset is taken before the case runs, so the INFO line already in
      // the log is not this case's fault.
      expect(await readHostErrors(log, 0)).toEqual([]);

      await writeFile(log, `${INFO_LINE}${ERROR_BLOCK}\n`, 'utf8');
      const appended = await readHostErrors(
        log,
        Buffer.byteLength(INFO_LINE),
        new Map([['ses_ec7e1725dffetH2YmTqboowL6x', 'scope push']]),
      );
      expect(appended).toHaveLength(1);
      expect(appended[0]?.case).toBe('scope push');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('starts at the line boundary after a mid-line offset, so a partial tail is not an error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openagentsy-host-errors-'));
    const log = join(root, 'server.log');
    try {
      // The offset is a byte position in the middle of a line a previous run
      // left behind. Sliced as-is, its tail begins with a header-shaped
      // string and would be read as an error of this run.
      const prefix = 'truncated tail ';
      const leftover = 'timestamp=2026-10-15T01:48:26.213Z level=ERROR run=old session.id=ses_old';
      await writeFile(log, `${leftover}\n${INFO_LINE}${ERROR_BLOCK}\n`, 'utf8');

      const errors = await readHostErrors(
        log,
        Buffer.byteLength(prefix),
        new Map([['ses_ec7e1725dffetH2YmTqboowL6x', 'scope push']]),
      );

      expect(errors).toHaveLength(1);
      expect(errors[0]?.sessionID).toBe('ses_ec7e1725dffetH2YmTqboowL6x');
      expect(errors[0]?.case).toBe('scope push');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('host errors the case injected', () => {
  const killed = 'ses_e910b2c07ffepW3IvLHGdkxrnz';

  it('does not treat an error naming a killed session as a host fault', () => {
    const faults = hostFaults(hostErrorsIn(KILLED_ERROR_BLOCK), new Set([killed]));
    expect(faults).toEqual([]);
  });

  it('keeps an error naming a session the harness did not kill', () => {
    const faults = hostFaults(hostErrorsIn(abortBlock('ses_other')), new Set([killed]));
    expect(faults).toHaveLength(1);
    expect(faults[0]?.sessionID).toBe('ses_other');
  });

  it('excludes the session the watch resolved', async () => {
    const aborted: string[] = [];
    const client = {
      session: {
        list: async () => ({ data: [{ id: 'ses_killed', title: 'eval oa-builder' }] }),
        abort: async ({ path }: { path: { id: string } }) => {
          aborted.push(path.id);
          return {};
        },
      },
    } as unknown as OpencodeClient;

    const watch = killSessionWhenItAppears(client, '/case', (title) => title.includes('builder'), {
      attempts: 1,
      intervalMs: 1,
      suppressMs: 1,
    });
    const killedSession = await watch.killed;
    watch.stop();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(killedSession).toBe('ses_killed');
    // The first abort is the kill; the suppression may have added one more of
    // the SAME session, and never of another one.
    expect(aborted.length).toBeGreaterThanOrEqual(1);
    expect(aborted.every((id) => id === 'ses_killed')).toBe(true);
    const faults = hostFaults(
      hostErrorsIn(`${abortBlock('ses_killed')}\n${abortBlock('ses_other')}`),
      new Set(killedSession === undefined ? [] : [killedSession]),
    );
    expect(faults).toHaveLength(1);
    expect(faults[0]?.sessionID).toBe('ses_other');
  });

  it('kills an untitled child that is new since the watch started', async () => {
    // The measured race: a dispatched builder finished a one-line task before
    // the server gave its session a title, so the title match never fired. A
    // session that is NEW since the first poll is the child, titled or not.
    const lists = [
      { data: [{ id: 'ses_lead', title: 'eval agentsy' }] },
      { data: [{ id: 'ses_lead', title: 'eval agentsy' }, { id: 'ses_child' }] },
    ];
    const aborted: string[] = [];
    const client = {
      session: {
        list: async () => lists.shift() ?? { data: [] },
        abort: async ({ path }: { path: { id: string } }) => {
          aborted.push(path.id);
          return {};
        },
      },
    } as unknown as OpencodeClient;

    const watch = killSessionWhenItAppears(client, '/case', (title) => title.includes('builder'), {
      attempts: 2,
      intervalMs: 1,
      suppressMs: 1,
    });
    const killedSession = await watch.killed;
    watch.stop();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(killedSession).toBe('ses_child');
    expect(aborted.length).toBeGreaterThanOrEqual(1);
    expect(aborted.every((id) => id === 'ses_child')).toBe(true);
  });

  it('keeps aborting the killed session after the first kill', async () => {
    // The measured defect: one abort cancelled the in-flight generation, the
    // session's loop resumed, and the child kept generating for nineteen
    // minutes. The watch must keep cutting the SAME session down until it
    // stops, while a re-dispatched builder (a new id) is never touched.
    const aborted: string[] = [];
    const client = {
      session: {
        list: async () => ({ data: [{ id: 'ses_killed', title: 'eval oa-builder' }] }),
        abort: async ({ path }: { path: { id: string } }) => {
          aborted.push(path.id);
          return {};
        },
      },
    } as unknown as OpencodeClient;

    const watch = killSessionWhenItAppears(client, '/case', (title) => title.includes('builder'), {
      attempts: 1,
      intervalMs: 1,
      suppressMs: 30,
    });
    const killedSession = await watch.killed;
    await new Promise((resolve) => setTimeout(resolve, 40));
    watch.stop();
    const after = aborted.length;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(killedSession).toBe('ses_killed');
    // The kill, then at least two suppression cuts of the same session.
    expect(aborted.length).toBeGreaterThanOrEqual(3);
    expect(aborted.every((id) => id === 'ses_killed')).toBe(true);
    // The watch is stopped, so nothing fires after it.
    expect(aborted.length).toBe(after);
  });
});
