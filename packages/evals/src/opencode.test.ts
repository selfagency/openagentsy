import { mkdtemp, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  attributeHostErrors,
  caseDirsOfRun,
  createCaseDir,
  HARNESS_SWEEP_AGE_MS,
  type HarnessClient,
  hostErrorsIn,
  hostFaults,
  IdleRegistry,
  idleSessionOf,
  injectedFaultLine,
  isWatcherFailure,
  killSessionWhenItAppears,
  logFields,
  type OpenCodeHarness,
  permissionPatterns,
  readHostErrors,
  readRuntime,
  removeCaseDir,
  removeHarnessFiles,
  replyPartsOf,
  runTurn,
  runtimeBinary,
  SessionGoneError,
  selectKillTarget,
  serveArgs,
  splitHostErrors,
  sweepStaleHarnessFiles,
  V2HarnessClient,
  waitForIdle,
  watcherExemptionLine,
} from './opencode.js';
import { V2HttpError, type V2Transport } from './v2client.js';

describe('selectKillTarget', () => {
  const isBuilder = (title: string) => title.includes('builder');

  it('takes the dispatched child, titled or not', () => {
    // The measured shapes (2026-10-27): the Lead and the judge are roots,
    // the builder and the archivist are children of the Lead, and the
    // builder's title arrives after it has already done the work.
    const sessions = [
      { id: 'lead', title: 'eval agentsy' },
      { id: 'judge', title: 'eval judge' },
      { id: 'builder', title: '', parentID: 'lead' },
    ];
    expect(selectKillTarget(sessions, new Set(['lead', 'judge']), isBuilder)).toBe('builder');
  });

  it('takes the builder even when it is already titled', () => {
    const sessions = [
      { id: 'lead', title: 'eval agentsy' },
      { id: 'builder', title: 'Write hello.txt one line (@oa-builder subagent)', parentID: 'lead' },
    ];
    expect(selectKillTarget(sessions, new Set(['lead']), isBuilder)).toBe('builder');
  });

  it('leaves the archivist alone: the Lead dispatches it last', () => {
    const sessions = [
      { id: 'lead', title: 'eval agentsy' },
      {
        id: 'archivist',
        title: 'Distil builder session learnings (@oa-archivist)',
        parentID: 'lead',
      },
    ];
    expect(selectKillTarget(sessions, new Set(['lead']), isBuilder)).toBeUndefined();
  });

  it('leaves the roots alone', () => {
    const sessions = [
      { id: 'lead', title: 'eval agentsy' },
      { id: 'judge', title: 'eval judge' },
    ];
    expect(selectKillTarget(sessions, new Set(), isBuilder)).toBeUndefined();
  });

  it('takes an untitled session that is new since the baseline', () => {
    const sessions = [{ id: 'fresh', title: '' }];
    expect(selectKillTarget(sessions, new Set(['lead']), isBuilder)).toBe('fresh');
  });
});

describe('the kill of a session', () => {
  it('deletes the session it killed, so the child cannot go on working', async () => {
    // The measured failure (2026-10-27): an abort cancelled the turn, and
    // the builder went on working for 59 seconds and posted its completion
    // record. The session has to go, not only the turn.
    const aborted: string[] = [];
    const deleted: string[] = [];
    const client = {
      listSessions: async () => [{ id: 'ses_killed', title: 'eval oa-builder' }],
      interrupt: async ({ sessionID }: { sessionID: string }) => {
        aborted.push(sessionID);
      },
      deleteSession: async ({ sessionID }: { sessionID: string }) => {
        deleted.push(sessionID);
      },
    } as unknown as HarnessClient;

    const watch = killSessionWhenItAppears(client, '/case', (title) => title.includes('builder'), {
      attempts: 1,
      intervalMs: 1,
      windowMs: 1,
    });
    const killedSession = await watch.killed;
    watch.stop();
    // The kill runs beside the watch, so the delete it ends with comes a
    // moment later.
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(killedSession).toBe('ses_killed');
    expect(deleted).toEqual(['ses_killed']);
    // The abort comes first: it is what stops the generation in flight.
    expect(aborted).toContain('ses_killed');
  });

  it('cuts the session before it deletes it, because a cut of a deleted session stops nothing', async () => {
    // The OpenCode 2 server finds a session by its row, so an interrupt of a
    // deleted session answers 404 and stops nothing (measured against a live
    // OpenCode 2 server, 2026-10-27). The row has to be there for the cut
    // to land, and it has to go in the end.
    const order: string[] = [];
    const client = {
      listSessions: async () => [{ id: 'ses_killed', title: 'eval oa-builder' }],
      interrupt: async () => {
        order.push('cut');
      },
      deleteSession: async () => {
        order.push('delete');
      },
    } as unknown as HarnessClient;

    const watch = killSessionWhenItAppears(client, '/case', (title) => title.includes('builder'), {
      attempts: 1,
      intervalMs: 1,
      windowMs: 5,
    });
    await watch.killed;
    // The kill runs beside the watch and cuts the session for its window, so
    // the watch is only stopped once the kill has ended.
    await new Promise((resolve) => setTimeout(resolve, 40));
    watch.stop();

    expect(order[0]).toBe('cut');
    expect(order.at(-1)).toBe('delete');
  });

  it('stops a builder that is working, so it cannot post a completion record', async () => {
    // The acceptance of the case: after the kill, the builder must not post a
    // completion record. The OpenCode 2 server answers an interrupt of an
    // idle session with interrupted=false and does nothing, and the watch
    // finds the session before its turn is running, so the first cut lands
    // on an idle session. A kill that cuts once therefore leaves the builder
    // working, and the builder posts its record.
    let cuts = 0;
    const posts: string[] = [];
    let working = true;
    const client = {
      listSessions: async () => [{ id: 'ses_killed', title: 'eval oa-builder' }],
      interrupt: async () => {
        cuts += 1;
        // The first cut lands on an idle session and does nothing.
        if (cuts > 1) working = false;
      },
      deleteSession: async () => {
        // The delete is refused, so the session stays and can go on working.
        throw new Error('the session is busy');
      },
    } as unknown as HarnessClient;

    const builder = (async () => {
      while (working) {
        posts.push('a completion record');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    })();

    const watch = killSessionWhenItAppears(client, '/case', (title) => title.includes('builder'), {
      attempts: 1,
      intervalMs: 1,
      windowMs: 50,
    });
    await watch.killed;
    // The builder stops when the second cut lands, which is inside the
    // window the kill cuts for.
    await builder;
    watch.stop();
    const posted = posts.length;
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Nothing was posted after the kill, and the session was cut more than
    // once, because the first cut can land on an idle session.
    expect(posts.length).toBe(posted);
    expect(cuts).toBeGreaterThan(1);
  });

  it('keeps killing the session when the server refuses the delete', async () => {
    const aborted: string[] = [];
    const client = {
      listSessions: async () => [{ id: 'ses_killed', title: 'eval oa-builder' }],
      interrupt: async ({ sessionID }: { sessionID: string }) => {
        aborted.push(sessionID);
      },
      deleteSession: async () => {
        throw new Error('the session is busy');
      },
    } as unknown as HarnessClient;

    const watch = killSessionWhenItAppears(client, '/case', (title) => title.includes('builder'), {
      attempts: 1,
      intervalMs: 1,
      windowMs: 30,
    });
    const killedSession = await watch.killed;
    await new Promise((resolve) => setTimeout(resolve, 40));
    watch.stop();

    expect(killedSession).toBe('ses_killed');
    // The delete was refused, so the abort is the kill there is, and the
    // same session is cut again and again.
    expect(aborted.length).toBeGreaterThanOrEqual(3);
    expect(aborted.every((id) => id === 'ses_killed')).toBe(true);
  });
});

describe('permissionPatterns', () => {
  it('reads the pattern the server sends, as a list', () => {
    // The server sends the pattern under the key "pattern", as a string or
    // as a list. A reader that looked for "patterns" saw an empty list for
    // every request, and a policy that refuses a path by its patterns could
    // then never refuse one.
    expect(permissionPatterns({ pattern: 'roles.yaml' })).toEqual(['roles.yaml']);
    expect(permissionPatterns({ pattern: ['roles.yaml', 'AGENTS.md'] })).toEqual([
      'roles.yaml',
      'AGENTS.md',
    ]);
    expect(permissionPatterns({})).toEqual([]);
  });
});

describe('the runtime the harness starts', () => {
  it('takes the binary from the environment', () => {
    const before = process.env.OPENAGENTSY_EVAL_BIN;
    process.env.OPENAGENTSY_EVAL_BIN = '/tmp/oa-v1/node_modules/.bin/opencode';
    try {
      expect(runtimeBinary()).toBe('/tmp/oa-v1/node_modules/.bin/opencode');
    } finally {
      if (before === undefined) delete process.env.OPENAGENTSY_EVAL_BIN;
      else process.env.OPENAGENTSY_EVAL_BIN = before;
    }
  });

  it('falls back to the one on the path', () => {
    const before = process.env.OPENAGENTSY_EVAL_BIN;
    delete process.env.OPENAGENTSY_EVAL_BIN;
    try {
      expect(runtimeBinary()).toBe('opencode');
    } finally {
      if (before !== undefined) process.env.OPENAGENTSY_EVAL_BIN = before;
    }
  });

  it('reads the version of the binary it is given', async () => {
    // A run that cannot name its runtime is a run whose result cannot be
    // read, so the version is read from the binary itself.
    const runtime = await readRuntime(process.execPath);

    expect(runtime.binary).toBe(process.execPath);
    expect(runtime.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(runtime.major).toBeGreaterThan(0);
  });

  it('stops when the runtime cannot be started', async () => {
    await expect(readRuntime('/no/such/opencode')).rejects.toThrow(/could not be started/);
  });
});

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
      expect((await readHostErrors(log, 0)).faults).toEqual([]);

      await writeFile(log, `${INFO_LINE}${ERROR_BLOCK}\n`, 'utf8');
      const appended = await readHostErrors(
        log,
        Buffer.byteLength(INFO_LINE),
        new Map([['ses_ec7e1725dffetH2YmTqboowL6x', 'scope push']]),
      );
      expect(appended.faults).toHaveLength(1);
      expect(appended.faults[0]?.case).toBe('scope push');
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

      expect(errors.faults).toHaveLength(1);
      expect(errors.faults[0]?.sessionID).toBe('ses_ec7e1725dffetH2YmTqboowL6x');
      expect(errors.faults[0]?.case).toBe('scope push');
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
      listSessions: async () => [{ id: 'ses_killed', title: 'eval oa-builder' }],
      interrupt: async ({ sessionID }: { sessionID: string }) => {
        aborted.push(sessionID);
      },
      deleteSession: async () => {},
    } as unknown as HarnessClient;

    const watch = killSessionWhenItAppears(client, '/case', (title) => title.includes('builder'), {
      attempts: 1,
      intervalMs: 1,
      windowMs: 1,
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

  it('keeps watching past a hundred polls, because the Lead decides when to dispatch', async () => {
    // The measured failure (2026-10-27): the watch gave up after 120 polls
    // of 500ms, and the Lead took two minutes to dispatch, so the fault never
    // landed. The watch lives until the harness stops it.
    let polls = 0;
    const aborted: string[] = [];
    const client = {
      listSessions: async () => {
        polls += 1;
        return polls < 200
          ? [{ id: 'ses_lead', title: 'eval agentsy' }]
          : [{ id: 'ses_lead', title: 'eval agentsy' }, { id: 'ses_child' }];
      },
      interrupt: async ({ sessionID }: { sessionID: string }) => {
        aborted.push(sessionID);
      },
      deleteSession: async () => {},
    } as unknown as HarnessClient;

    const watch = killSessionWhenItAppears(client, '/case', (title) => title.includes('builder'), {
      intervalMs: 1,
      windowMs: 1,
    });
    const killedSession = await watch.killed;
    watch.stop();

    expect(polls).toBeGreaterThan(120);
    expect(killedSession).toBe('ses_child');
    expect(aborted).toContain('ses_child');
  });

  it('kills an untitled child that is new since the watch started', async () => {
    // The measured race: a dispatched builder finished a one-line task before
    // the server gave its session a title, so the title match never fired. A
    // session that is NEW since the first poll is the child, titled or not.
    const lists = [
      [{ id: 'ses_lead', title: 'eval agentsy' }],
      [{ id: 'ses_lead', title: 'eval agentsy' }, { id: 'ses_child' }],
    ];
    const aborted: string[] = [];
    const client = {
      listSessions: async () => lists.shift() ?? [],
      interrupt: async ({ sessionID }: { sessionID: string }) => {
        aborted.push(sessionID);
      },
      deleteSession: async () => {},
    } as unknown as HarnessClient;

    const watch = killSessionWhenItAppears(client, '/case', (title) => title.includes('builder'), {
      attempts: 2,
      intervalMs: 1,
      windowMs: 1,
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
      listSessions: async () => [{ id: 'ses_killed', title: 'eval oa-builder' }],
      interrupt: async ({ sessionID }: { sessionID: string }) => {
        aborted.push(sessionID);
      },
      deleteSession: async () => {},
    } as unknown as HarnessClient;

    const watch = killSessionWhenItAppears(client, '/case', (title) => title.includes('builder'), {
      attempts: 1,
      intervalMs: 1,
      windowMs: 30,
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

/**
 * The error the server writes when the fault a case injected lands.
 *
 * Measured on 2026-10-27 in `fault model 429`: the provider answers 429 to
 * everything, and the server writes the turn it could not finish as an ERROR
 * naming the session.
 */
function faultedError(sessionID: string): string {
  return `timestamp=2026-10-27T19:12:42.078Z level=ERROR run=a7660939 message="Failed to drain Session" cause="AI.Error: injected fault: rate limited" role=server sessionID=${sessionID}`;
}

describe('the errors of a session the case faulted', () => {
  const faulted = 'ses_e8139e62fffeTuui4O90HYVgoQ';

  it('does not treat the error of a faulted session as a host fault', () => {
    const split = splitHostErrors(
      hostErrorsIn(faultedError(faulted)),
      new Set(),
      new Set([faulted]),
    );

    expect(split.faults).toEqual([]);
    expect(split.injected).toHaveLength(1);
  });

  it('keeps the error of a session the case did not fault', () => {
    const split = splitHostErrors(
      hostErrorsIn(faultedError('ses_other')),
      new Set(),
      new Set([faulted]),
    );

    expect(split.faults).toHaveLength(1);
    expect(split.injected).toEqual([]);
  });

  it('counts the errors of a faulted session and reports the first one', () => {
    const split = splitHostErrors(
      hostErrorsIn(`${faultedError(faulted)}\n${faultedError(faulted)}`),
      new Set(),
      new Set([faulted]),
    );
    const line = injectedFaultLine(attributeHostErrors(split.injected, new Map()));

    expect(line).toContain('2 error(s)');
    expect(line).toContain('injected fault: rate limited');
  });

  it('reads the error of a faulted session out of the log as the case own doing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openagentsy-host-errors-'));
    const log = join(root, 'server.log');
    try {
      // The other error in the same log is still a fault: the exclusion is
      // for one session, not for the log.
      await writeFile(log, `${faultedError(faulted)}\n${ERROR_BLOCK}\n`, 'utf8');

      const report = await readHostErrors(log, 0, new Map(), new Set(), new Set([faulted]));

      expect(report.injected).toHaveLength(1);
      expect(report.faults).toHaveLength(1);
      expect(report.faults[0]?.line).toContain('FOREIGN KEY constraint failed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('a session that is gone', () => {
  const GONE = JSON.stringify({
    _tag: 'SessionNotFoundError',
    sessionID: 'ses_gone',
    message: 'Session not found: ses_gone',
  });

  it('says the session is gone instead of failing on the 404 of the server', async () => {
    const transport: V2Transport = {
      request: async () => new Response(GONE, { status: 404 }),
    };
    const client = new V2HarnessClient({ baseUrl: 'http://127.0.0.1:4096', transport });

    await expect(client.messages({ sessionID: 'ses_gone', directory: '/case' })).rejects.toThrow(
      SessionGoneError,
    );
  });

  it('keeps a 404 that names no session a fault of the host', async () => {
    // A 404 on a path that must exist is still a fault: only the answer
    // that names a missing session is a session that is gone.
    const transport: V2Transport = {
      request: async () => new Response('{"message":"not found"}', { status: 404 }),
    };
    const client = new V2HarnessClient({ baseUrl: 'http://127.0.0.1:4096', transport });

    await expect(client.messages({ sessionID: 'ses_gone', directory: '/case' })).rejects.toThrow(
      V2HttpError,
    );
  });

  it('ends the turn with nothing when the session is gone', async () => {
    // The case removed its own session, so the turn produced nothing. The
    // case's own expectations judge that, and the harness does not fail the
    // case with the 404 of the server.
    const client = {
      createSession: async () => 'ses_gone',
      prompt: async () => {},
      busySessions: async () => new Set<string>(),
      messages: async () => {
        throw new SessionGoneError('ses_gone');
      },
    } as unknown as HarnessClient;
    const harness = {
      client,
      trackSession: () => {},
      markFaultedSession: () => {},
      idle: new IdleRegistry(),
    } as unknown as OpenCodeHarness;

    const turn = await runTurn({
      harness,
      directory: '/case',
      agent: 'agentsy',
      text: 'the question',
      waitForBoard: false,
      timeoutMs: 1_000,
    });

    expect(turn.text).toBe('');
    expect(turn.sessionID).toBe('ses_gone');
  });
});

/**
 * The line the server writes when its file watcher cannot attach.
 *
 * Measured on 2026-10-27 on macOS: the server opens a watcher on the
 * directory a case serves, and FSEvents refuses to open a stream for a path
 * under the OS temp dir. This error was the whole content of the teardown
 * failure of every run on that machine. The OpenCode 2 server watches the
 * machine's global skill directories as well, and the same error lands there.
 */
function watcherError(directory: string): string {
  return `timestamp=2026-10-27T15:34:58.573Z level=ERROR run=bc5593e8 message="failed to subscribe" directory=${directory} cause="Error: Error starting FSEvents stream ..."`;
}

/** An ERROR that is not a watcher failure, on any path. */
function otherError(directory: string): string {
  return `timestamp=2026-10-27T15:34:58.573Z level=ERROR run=bc5593e8 message="prompt_async failed" directory=${directory} cause="Error: EffectDrizzleQueryError"`;
}

describe('a watcher that cannot attach', () => {
  it('does not treat a watcher that cannot attach to a case directory as a host fault', async () => {
    const dir = await createCaseDir('watcher-probe');
    try {
      // The server logs the path it resolved, and on macOS the temp dir is
      // behind a symlink.
      const resolved = await realpath(dir);
      const split = splitHostErrors(
        hostErrorsIn(watcherError(join(resolved, '.git'))),
        new Set<string>(),
      );

      expect(split.faults).toEqual([]);
      expect(split.exempted).toHaveLength(1);
      expect(split.exempted[0]?.line).toContain('failed to subscribe');
    } finally {
      await removeCaseDir(dir);
    }
  });

  it('does not treat a watcher that cannot attach on any other path as a host fault', () => {
    // The OpenCode 2 server also watches the machine's global skill
    // directories, and the watcher cannot attach to those either. The path is
    // not what decides: a watcher that cannot attach is not a host fault, and
    // a case that passed while the host failed did not measure the agent.
    const split = splitHostErrors(
      hostErrorsIn(watcherError('/Users/someone/.claude/skills')),
      new Set<string>(),
    );

    expect(split.faults).toEqual([]);
    expect(split.exempted).toHaveLength(1);
  });

  it('keeps a different error raised in a case directory', async () => {
    const dir = await createCaseDir('watcher-probe');
    try {
      const split = splitHostErrors(hostErrorsIn(otherError(join(dir, '.git'))), new Set<string>());

      expect(split.faults).toHaveLength(1);
      expect(split.exempted).toEqual([]);
    } finally {
      await removeCaseDir(dir);
    }
  });

  it('keeps a different error raised on any other path', () => {
    const split = splitHostErrors(
      hostErrorsIn(otherError('/Users/someone/project/.git')),
      new Set<string>(),
    );

    expect(split.faults).toHaveLength(1);
    expect(split.exempted).toEqual([]);
  });

  it('does not mistake a look-alike path for a case directory in the report', async () => {
    const dir = await createCaseDir('watcher-probe');
    try {
      // The path no longer decides the fault: the watcher could not attach,
      // and that is not a host fault wherever it happened.
      const lookalike = `${dir}-other/.git`;
      const split = splitHostErrors(hostErrorsIn(watcherError(lookalike)), new Set<string>());

      expect(split.faults).toEqual([]);
      expect(split.exempted).toHaveLength(1);

      // The report is where the path still matters, and a sibling with the
      // same prefix is not a directory of this run.
      const line = watcherExemptionLine(
        attributeHostErrors(split.exempted, new Map()),
        caseDirsOfRun(),
      );

      expect(line).toContain('on another path');
      expect(line).not.toContain('throwaway directory of this run');
    } finally {
      await removeCaseDir(dir);
    }
  });

  it('reports the exempted errors: the count and the first one', async () => {
    const dir = await createCaseDir('watcher-probe');
    try {
      const split = splitHostErrors(
        hostErrorsIn(`${watcherError(join(dir, '.git'))}\n${watcherError(join(dir, '.git'))}`),
        new Set<string>(),
      );
      const line = watcherExemptionLine(
        attributeHostErrors(split.exempted, new Map()),
        caseDirsOfRun(),
      );

      expect(line).toContain('2 watcher error(s)');
      expect(line).toContain('failed to subscribe');
      expect(line).toContain(join(dir, '.git'));
    } finally {
      await removeCaseDir(dir);
    }
  });

  it('reads the exempted error out of the log as an exemption, not as a fault', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openagentsy-host-errors-'));
    const log = join(root, 'server.log');
    const dir = await createCaseDir('watcher-probe');
    try {
      // The other error in the same log is still a fault: the exemption is
      // for one kind of error, not for the log.
      await writeFile(log, `${watcherError(join(dir, '.git'))}\n${ERROR_BLOCK}\n`, 'utf8');

      const report = await readHostErrors(log, 0);

      expect(report.exempted).toHaveLength(1);
      expect(report.faults).toHaveLength(1);
      expect(report.faults[0]?.line).toContain('FOREIGN KEY constraint failed');
    } finally {
      await rm(root, { recursive: true, force: true });
      await removeCaseDir(dir);
    }
  });

  it('tells a watcher failure from any other error, whatever the path', () => {
    expect(isWatcherFailure({ line: watcherError('/tmp/case/.git') })).toBe(true);
    expect(isWatcherFailure({ line: otherError('/tmp/case/.git') })).toBe(false);
    // A failure to subscribe that names no directory is not a file watcher:
    // the harness reads the event stream, and a stream that cannot be
    // subscribed to is a fault of the host.
    expect(isWatcherFailure({ line: 'level=ERROR message="failed to subscribe"' })).toBe(false);
  });

  it('reads the fields of a log line, and a field inside a quoted value is not a field', () => {
    const fields = logFields(
      'timestamp=2026-10-27T15:34:58.573Z level=ERROR message="failed to subscribe" directory=/tmp/case cause="Error: message=not a field"',
    );

    expect(fields.get('message')).toBe('failed to subscribe');
    expect(fields.get('directory')).toBe('/tmp/case');
    expect(fields.get('cause')).toBe('Error: message=not a field');
  });
});

/**
 * The idle event of the event stream.
 *
 * The v1 server sends `{type, properties}` and the v2 server sends the
 * envelope `{id, created, type, location?, data}`. The harness's own
 * subscription receives the v1 shape today and the v2 client hands over
 * the other one, so both are read.
 */
describe('the idle event of the stream', () => {
  it('reads the session out of the v1 shape', () => {
    expect(idleSessionOf({ type: 'session.idle', properties: { sessionID: 'ses_a' } })).toBe(
      'ses_a',
    );
  });

  it('reads the session out of the v2 envelope', () => {
    expect(
      idleSessionOf({
        id: 'evt_1',
        created: 1,
        type: 'session.idle',
        data: { sessionID: 'ses_b' },
      }),
    ).toBe('ses_b');
  });

  it('reads a status that says the session is idle', () => {
    expect(
      idleSessionOf({
        type: 'session.status',
        properties: { sessionID: 'ses_c', status: { type: 'idle' } },
      }),
    ).toBe('ses_c');
    expect(
      idleSessionOf({
        type: 'session.status',
        properties: { sessionID: 'ses_c', status: { type: 'busy' } },
      }),
    ).toBeUndefined();
  });

  it('says nothing about the other events', () => {
    expect(
      idleSessionOf({ type: 'permission.updated', properties: { sessionID: 'ses_d' } }),
    ).toBeUndefined();
    expect(idleSessionOf({ type: 'session.idle' })).toBeUndefined();
    expect(idleSessionOf(undefined)).toBeUndefined();
  });
});

/**
 * The wait for a turn to end.
 *
 * The server says a session is idle when its turn is over, and the case
 * that hung for thirty minutes never heard it: the wait polled the busy
 * map and looked at the last message, and the event that ended the turn
 * went past it.
 */
describe('the end of a turn', () => {
  const directory = '/case';

  /**
   * A client that answers the two calls the wait makes.
   *
   * The count of the polls is what a test reads: a wait that ends on the
   * event never polls.
   */
  function fakeClient(answers: {
    status?: (polls: number) => Record<string, unknown>;
    messages?: () => unknown[];
  }): { client: HarnessClient; polls: () => number } {
    let polls = 0;
    const client = {
      busySessions: async () => {
        const answer = answers.status?.(polls) ?? {};
        polls += 1;
        return new Set(Object.keys(answer));
      },
      messages: async () => answers.messages?.() ?? [],
    } as unknown as HarnessClient;
    return { client, polls: () => polls };
  }

  it('ends the wait when the server says the session under test is idle', async () => {
    const idle = new IdleRegistry();
    idle.beginTurn('ses_under_test');
    // The event arrives after the prompt, so it belongs to this turn.
    idle.record('ses_under_test');
    const { client, polls } = fakeClient({});

    await waitForIdle({
      client,
      sessionID: 'ses_under_test',
      directory,
      timeoutMs: 1_000,
      idle,
      pollMs: 1,
    });

    // The wait ended on the event: it never asked the server.
    expect(polls()).toBe(0);
  });

  it('does not end the wait on the idle of another session', async () => {
    const idle = new IdleRegistry();
    idle.beginTurn('ses_under_test');
    // The event fires for every session of the case: the Lead, the
    // builders, the judge.
    idle.record('ses_judge');
    const { client, polls } = fakeClient({
      messages: () => [{ info: { role: 'assistant', time: { completed: 1 } } }],
    });

    await waitForIdle({
      client,
      sessionID: 'ses_under_test',
      directory,
      timeoutMs: 1_000,
      idle,
      pollMs: 1,
    });

    // The poll ran, so the other session's idle did not end the wait.
    expect(polls()).toBeGreaterThan(0);
  });

  it('ends the wait on the poll when the server sends no event', async () => {
    const idle = new IdleRegistry();
    idle.beginTurn('ses_under_test');
    const { client, polls } = fakeClient({
      // The session is busy on the first poll and idle on the second.
      status: (count) => (count === 0 ? { ses_under_test: {} } : {}),
    });

    await waitForIdle({
      client,
      sessionID: 'ses_under_test',
      directory,
      timeoutMs: 1_000,
      idle,
      pollMs: 1,
    });

    expect(polls()).toBe(2);
  });

  it('names the state of the turn when the wait runs out', async () => {
    const idle = new IdleRegistry();
    idle.beginTurn('ses_under_test');
    const { client } = fakeClient({
      status: () => ({ ses_under_test: {} }),
      messages: () => [],
    });

    const message = await waitForIdle({
      client,
      sessionID: 'ses_under_test',
      directory,
      timeoutMs: 30,
      idle,
      pollMs: 1,
    }).then(
      () => 'the wait did not fail',
      (error: unknown) => (error as Error).message,
    );

    expect(message).toContain('ses_under_test');
    expect(message).toContain('the server reported the session busy: yes');
    expect(message).toContain('the server sent an idle event for the session: no');
    expect(message).toContain('the last assistant message: none');
    expect(message).toContain('the wait had gone on for');
  });
});
