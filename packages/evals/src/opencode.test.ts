import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  attributeHostErrors,
  hostErrorsIn,
  readHostErrors,
  replyPartsOf,
  serveArgs,
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
