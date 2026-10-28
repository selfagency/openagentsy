import { describe, expect, it } from 'vitest';
import { candidateRecord, fakeReader, temporaryRoot } from './fixtures.js';
import { MemoryInbox, parseCandidateState } from './inbox.js';
import { type MemoryAuditDetail, MemoryStore } from './store.js';

async function inboxIn(root: string, records: ReturnType<typeof candidateRecord>[]) {
  const audited: { policyId: string; detail: MemoryAuditDetail }[] = [];
  const store = new MemoryStore({ root });
  const inbox = new MemoryInbox({
    root,
    read: fakeReader(records),
    store,
    onAudit: (policyId, detail) => {
      audited.push({ policyId, detail });
    },
  });
  return { inbox, store, audited };
}

describe('the memory inbox', () => {
  it('lists the candidates no person has decided on', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      const records = [
        candidateRecord({ id: 1 }),
        candidateRecord({ id: 2, state: 'promoted' }),
        candidateRecord({ id: 3, bean: 'other' }),
      ];
      const { inbox } = await inboxIn(root, records);
      const pending = await inbox.pending();
      expect(pending.map((record) => record.id)).toEqual([1]);
    } finally {
      await remove();
    }
  });

  it('reads the category and the source out of the record state', () => {
    expect(parseCandidateState('build · 2a-1')).toEqual({
      category: 'build',
      source: '2a-1',
    });
    expect(parseCandidateState('nothing here')).toEqual({
      category: 'uncategorized',
      source: 'nothing here',
    });
  });

  it('approves a candidate into the store and marks the record promoted', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      const records = [candidateRecord({ id: 7 })];
      const { inbox, store, audited } = await inboxIn(root, records);
      const outcome = await inbox.decide(7, 'approve', 'daniel');
      expect(outcome.ok).toBe(true);

      const entries = await store.entries();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.source).toBe('7 · 2a-1');
      expect(entries[0]?.category).toBe('build');
      // An approved candidate becomes a trusted memory (the human's
      // decision of 2026-10-28); the approval is the person's act.
      expect(entries[0]?.verified).toBe(true);
      expect(records[0]?.state).toBe('promoted');
      expect(audited).toEqual([
        {
          policyId: 'oa.memory.decide',
          detail: { recordId: 7, decidedBy: 'daniel', decision: 'approve' },
        },
      ]);
    } finally {
      await remove();
    }
  });

  it('rejects a candidate, and the store never sees the text', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      const records = [candidateRecord({ id: 7 })];
      const { inbox, store, audited } = await inboxIn(root, records);
      const outcome = await inbox.decide(7, 'reject', 'daniel');
      expect(outcome.ok).toBe(true);
      expect(await store.entries()).toEqual([]);
      expect(records[0]?.state).toBe('rejected');
      expect(audited).toEqual([
        {
          policyId: 'oa.memory.decide',
          detail: { recordId: 7, decidedBy: 'daniel', decision: 'reject' },
        },
      ]);
    } finally {
      await remove();
    }
  });

  it('refuses a record that is not a candidate, and one that was decided', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      const records = [candidateRecord({ id: 7, bean: 'other' }), candidateRecord({ id: 8 })];
      const { inbox } = await inboxIn(root, records);

      const notACandidate = await inbox.decide(7, 'approve', 'daniel');
      expect(notACandidate.ok).toBe(false);
      if (!notACandidate.ok) expect(notACandidate.reason).toBe('not-a-candidate');

      await inbox.decide(8, 'reject', 'daniel');
      const twice = await inbox.decide(8, 'approve', 'daniel');
      expect(twice.ok).toBe(false);
      if (!twice.ok) expect(twice.reason).toBe('already-decided');
    } finally {
      await remove();
    }
  });

  it('refuses a record that does not exist', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      const { inbox } = await inboxIn(root, []);
      const outcome = await inbox.decide(99, 'approve', 'daniel');
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toBe('unknown-record');
    } finally {
      await remove();
    }
  });

  it('writes the state back through the injected writer', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      const marked: { recordId: number; state: string }[] = [];
      const store = new MemoryStore({ root });
      const inbox = new MemoryInbox({
        root,
        read: fakeReader([candidateRecord({ id: 7 })]),
        store,
        markState: (recordId, state) => {
          marked.push({ recordId, state });
        },
      });
      await inbox.decide(7, 'approve', 'daniel');
      expect(marked).toEqual([{ recordId: 7, state: 'promoted' }]);
    } finally {
      await remove();
    }
  });
});
