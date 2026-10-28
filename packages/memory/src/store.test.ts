import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { temporaryRoot } from './fixtures.js';
import { type MemoryAuditDetail, MemoryStore } from './store.js';

/** A key that looks like an AWS access key, so the redaction finds it. */
const SEEDED_KEY = 'AKIAIOSFODNN7EXAMPLE';

async function storeIn(
  root: string,
  onAudit?: (policyId: string, detail: MemoryAuditDetail) => void,
): Promise<MemoryStore> {
  return new MemoryStore({
    root,
    now: () => new Date('2026-10-26T12:00:00.000Z'),
    ...(onAudit === undefined ? {} : { onAudit }),
  });
}

describe('the memory store', () => {
  it('writes one line per memory', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      const store = await storeIn(root);
      const outcome = await store.append({
        text: 'The lease guard refuses a write to a file no lease covers.',
        category: 'build',
        source: '7 · 2a-1',
        confidence: 'inferred',
      });
      expect(outcome.ok).toBe(true);

      const path = join(root, '.openagentsy', 'memory.jsonl');
      const lines = (await readFile(path, 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(1);
      const entry = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
      expect(entry.id).toMatch(/^oa-mem-[A-Za-z0-9_-]{6}$/);
      expect(entry.category).toBe('build');
      expect(entry.source).toBe('7 · 2a-1');
      expect(entry.confidence).toBe('inferred');
      expect(entry.created_at).toBe('2026-10-26T12:00:00.000Z');
      // A memory is trusted on write; a person marks it unverified when
      // they disagree (the human's decision of 2026-10-28).
      expect(entry.verified).toBe(true);
    } finally {
      await remove();
    }
  });

  it('redacts before it writes, and says how much it redacted', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      const store = await storeIn(root);
      const outcome = await store.append({
        text: `The key is ${SEEDED_KEY} and it must not be kept.`,
        category: 'build',
        source: '7 · 2a-1',
        confidence: 'verified',
      });
      expect(outcome.ok).toBe(true);
      expect(outcome.redactions).toBe(1);

      const written = await readFile(join(root, '.openagentsy', 'memory.jsonl'), 'utf8');
      expect(written).not.toContain(SEEDED_KEY);
      expect(written).toContain('redacted:aws-access-key');
    } finally {
      await remove();
    }
  });

  it('refuses a duplicate with the id of the memory that holds it', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      const store = await storeIn(root);
      const first = await store.append({
        text: 'The lease guard refuses a write to a file no lease covers.',
        category: 'build',
        source: '7 · 2a-1',
        confidence: 'inferred',
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      const second = await store.append({
        text: '  The LEASE guard refuses a write to a file no lease covers.  ',
        category: 'build',
        source: '8 · 2a-2',
        confidence: 'inferred',
      });
      expect(second.ok).toBe(false);
      if (second.ok) throw new Error('the duplicate was accepted');
      expect(second.reason).toBe('duplicate');
      if (second.reason !== 'duplicate') throw new Error(`the outcome was ${second.reason}`);
      expect(second.id).toBe(first.entry.id);
    } finally {
      await remove();
    }
  });

  it('refuses a text that is too long, and a category that is not a tag', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      const store = await storeIn(root);
      const long = await store.append({
        text: 'x'.repeat(281),
        category: 'build',
        source: '7 · 2a-1',
        confidence: 'guess',
      });
      expect(long.ok).toBe(false);
      if (!long.ok) expect(long.reason).toBe('invalid');

      const tagged = await store.append({
        text: 'A short enough text.',
        category: 'Not A Tag',
        source: '7 · 2a-1',
        confidence: 'guess',
      });
      expect(tagged.ok).toBe(false);
    } finally {
      await remove();
    }
  });

  it('folds a forget marker into the view and keeps the line in the file', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      const store = await storeIn(root);
      const outcome = await store.append({
        text: 'A memory that is about to be forgotten.',
        category: 'build',
        source: '7 · 2a-1',
        confidence: 'guess',
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;

      expect(await store.forget(outcome.entry.id, 'daniel')).toBe(true);
      expect(await store.entries()).toEqual([]);

      const lines = (await readFile(join(root, '.openagentsy', 'memory.jsonl'), 'utf8'))
        .trim()
        .split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[1] ?? '{}')).toMatchObject({
        kind: 'forget',
        id: outcome.entry.id,
        by: 'daniel',
      });
    } finally {
      await remove();
    }
  });

  it('marks a memory verified, and audits who did it', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      const audited: { policyId: string; detail: MemoryAuditDetail }[] = [];
      const store = await storeIn(root, (policyId, detail) => {
        audited.push({ policyId, detail });
      });
      const outcome = await store.append({
        text: 'A memory that a person will verify.',
        category: 'build',
        source: '7 · 2a-1',
        confidence: 'guess',
        // A person marked it unverified when it was written; the call
        // below marks it verified.
        verified: false,
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.entry.verified).toBe(false);

      expect(await store.verify(outcome.entry.id, 'daniel')).toBe(true);
      const entries = await store.entries();
      expect(entries[0]?.verified).toBe(true);
      expect(audited).toEqual([
        { policyId: 'oa.memory.verify', detail: { id: outcome.entry.id, decidedBy: 'daniel' } },
      ]);
    } finally {
      await remove();
    }
  });

  it('reads the file once until it changes', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      const store = await storeIn(root);
      await store.append({
        text: 'The first memory.',
        category: 'build',
        source: '7 · 2a-1',
        confidence: 'guess',
      });
      expect(await store.entries()).toHaveLength(1);

      // The cache is keyed on the file's stat, so a line written behind the
      // store's back is seen on the next read.
      const path = join(root, '.openagentsy', 'memory.jsonl');
      const { appendFile } = await import('node:fs/promises');
      await appendFile(
        path,
        `${JSON.stringify({
          id: 'oa-mem-external',
          text: 'A memory written by someone else.',
          category: 'build',
          source: '9 · 2a-9',
          confidence: 'guess',
          created_at: '2026-10-26T12:00:00.000Z',
          verified: false,
        })}\n`,
        'utf8',
      );
      expect(await store.entries()).toHaveLength(2);
    } finally {
      await remove();
    }
  });

  it('has no file before the first memory', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      const store = await storeIn(root);
      expect(existsSync(join(root, '.openagentsy', 'memory.jsonl'))).toBe(false);
      expect(await store.entries()).toEqual([]);
    } finally {
      await remove();
    }
  });
});
