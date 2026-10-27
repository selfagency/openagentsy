import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { POLICIES, rotateAudit } from './audit.js';

let dir: string;
let path: string;

/** One audit line, shaped like the entries `appendAudit` writes. */
function line(index: number): string {
  return `${JSON.stringify({
    ts: '2026-10-24T12:00:00.000Z',
    policyId: 'oa.lease.grant',
    policyVersion: 'v1',
    actor: 'lead',
    action: 'grant',
    resource: `src/file-${index}.ts`,
    effect: 'allow',
  })}\n`;
}

function lines(...indexes: number[]): string {
  return indexes.map(line).join('');
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'openagentsy-audit-'));
  path = join(dir, 'audit.jsonl');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the approval policies', () => {
  it('names the grant and the use', () => {
    expect(POLICIES.approveGranted).toEqual({ id: 'oa.approve.granted', version: 'v1' });
    expect(POLICIES.approveUsed).toEqual({ id: 'oa.approve.used', version: 'v1' });
  });
});

describe('rotateAudit', () => {
  it('leaves a log under the cap alone', async () => {
    await writeFile(path, lines(0, 1), 'utf8');

    const result = await rotateAudit(path, { maxBytes: 10_000 });

    expect(result.rotated).toBe(false);
    expect(await readFile(path, 'utf8')).toBe(lines(0, 1));
  });

  it('keeps the newest lines in audit.jsonl and moves the older ones beside it', async () => {
    await writeFile(path, lines(0, 1, 2, 3, 4, 5), 'utf8');
    // Room for two of the six lines: the four oldest must move out.
    const maxBytes = Buffer.byteLength(line(0)) * 2;

    const result = await rotateAudit(path, { maxBytes });

    expect(result.rotated).toBe(true);
    expect(result.movedLines).toBe(4);
    expect(result.archive).toBe(join(dir, 'audit.1.jsonl'));
    // The newest entries stay in the live log, in their original order.
    expect(await readFile(path, 'utf8')).toBe(lines(4, 5));
    // The older ones are in the numbered file beside it.
    expect(await readFile(join(dir, 'audit.1.jsonl'), 'utf8')).toBe(lines(0, 1, 2, 3));
  });

  it('drops the oldest numbered file beyond the limit and reports it', async () => {
    await writeFile(path, lines(0, 1, 2, 3, 4, 5), 'utf8');
    // A history already at the limit: two archives, both with content.
    await writeFile(join(dir, 'audit.1.jsonl'), lines(10), 'utf8');
    await writeFile(join(dir, 'audit.2.jsonl'), lines(11), 'utf8');
    const maxBytes = Buffer.byteLength(line(0)) * 2;

    const result = await rotateAudit(path, { maxBytes, keep: 2 });

    expect(result.rotated).toBe(true);
    // The oldest archive is the one evicted.
    expect(result.dropped).toBe(join(dir, 'audit.2.jsonl'));
    // The old audit.1 moved up, and the newly rotated lines took its slot.
    expect(await readFile(join(dir, 'audit.2.jsonl'), 'utf8')).toBe(lines(10));
    expect(await readFile(join(dir, 'audit.1.jsonl'), 'utf8')).toBe(lines(0, 1, 2, 3));
    expect(await readFile(path, 'utf8')).toBe(lines(4, 5));
  });

  it('keeps the newest line when a single line is already over the cap', async () => {
    await writeFile(path, lines(0, 1), 'utf8');
    // No room at all: the live log must still hold its newest entry, and the
    // only line that can move is the one before it.
    const result = await rotateAudit(path, { maxBytes: 1 });

    expect(result.rotated).toBe(true);
    expect(await readFile(path, 'utf8')).toBe(line(1));
    expect(await readFile(join(dir, 'audit.1.jsonl'), 'utf8')).toBe(line(0));
  });

  it('leaves one huge line in place when there is nothing older to move', async () => {
    await writeFile(path, line(0), 'utf8');

    const result = await rotateAudit(path, { maxBytes: 1 });

    expect(result.rotated).toBe(false);
    expect(await readFile(path, 'utf8')).toBe(line(0));
  });

  it('does not throw when the path is missing', async () => {
    const result = await rotateAudit(join(dir, 'missing.jsonl'));
    expect(result.rotated).toBe(false);
  });
});
