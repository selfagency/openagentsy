import { describe, expect, it } from 'vitest';
import { candidateRecord, fakeReader, temporaryRoot } from './fixtures.js';
import { MemoryInbox } from './inbox.js';
import { MemoryStore } from './store.js';
import { createMemoryTools } from './tools.js';

const ctx = { sessionID: 'test-session', agent: 'oa-builder' };

/** A store whose clock steps forward, so the order of two memories is fixed. */
function steppingStore(root: string): MemoryStore {
  let tick = 0;
  return new MemoryStore({
    root,
    now: () => {
      tick += 1;
      return new Date(Date.UTC(2026, 9, 26, 12, 0, tick));
    },
  });
}

async function toolsIn(root: string, records: ReturnType<typeof candidateRecord>[]) {
  const store = steppingStore(root);
  const inbox = new MemoryInbox({ root, read: fakeReader(records), store });
  return { tools: createMemoryTools({ store, inbox }), store, inbox };
}

describe('the memory tools', () => {
  it('redacts an unverified memory in a search, unless the caller asks for it', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      const { tools, store } = await toolsIn(root, []);
      await store.append({
        text: 'The lease guard refuses a write to a file no lease covers.',
        category: 'build',
        source: '7 · 2a-1',
        confidence: 'inferred',
        // A memory is trusted on write; this one is marked unverified, so
        // the search redacts it until the caller asks for it.
        verified: false,
      });

      const hidden = (await tools.oa_memory_search.execute({ q: 'lease' }, ctx)) as {
        hits: { id: string; text: string }[];
      };
      expect(hidden.hits).toHaveLength(1);
      expect(hidden.hits[0]?.text).toMatch(/^\[unverified: oa-mem-[A-Za-z0-9_-]{6}\]$/);

      const shown = (await tools.oa_memory_search.execute(
        { q: 'lease', includeUnverified: true },
        ctx,
      )) as { hits: { text: string }[] };
      expect(shown.hits[0]?.text).toContain('lease guard');
    } finally {
      await remove();
    }
  });

  it('orders the results so the best ones are where a model looks first', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      const { tools, store } = await toolsIn(root, []);
      await store.append({
        text: 'alpha beta',
        category: 'build',
        source: '1 · a',
        confidence: 'guess',
      });
      await store.append({
        text: 'alpha',
        category: 'build',
        source: '2 · b',
        confidence: 'guess',
      });
      await store.append({
        text: 'beta',
        category: 'build',
        source: '3 · c',
        confidence: 'guess',
      });

      const found = (await tools.oa_memory_search.execute(
        { q: 'alpha beta', includeUnverified: true },
        ctx,
      )) as { hits: { text: string }[] };
      // The best match is first and the second best is last, so the two
      // strongest results sit where a model looks first. The second best is
      // 'beta': it scores the same as 'alpha' and is the newer of the two.
      const texts = found.hits.map((hit) => hit.text);
      expect(texts[0]).toBe('alpha beta');
      expect(texts[texts.length - 1]).toBe('beta');
    } finally {
      await remove();
    }
  });

  it('finds a memory by its category', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      const { tools, store } = await toolsIn(root, []);
      await store.append({
        text: 'The lease guard refuses a write to a file no lease covers.',
        category: 'guard',
        source: '7 · 2a-1',
        confidence: 'guess',
      });
      await store.append({
        text: 'The redaction runs before an entry is appended.',
        category: 'privacy',
        source: '8 · 2a-2',
        confidence: 'guess',
      });

      const found = (await tools.oa_memory_search.execute(
        { q: 'lease', category: 'guard' },
        ctx,
      )) as { hits: { text: string }[] };
      expect(found.hits).toHaveLength(1);
    } finally {
      await remove();
    }
  });

  it('lists the recent memories and how many candidates wait', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      const { tools, store } = await toolsIn(root, [
        candidateRecord({ id: 1 }),
        candidateRecord({ id: 2 }),
      ]);
      await store.append({
        text: 'The lease guard refuses a write to a file no lease covers.',
        category: 'build',
        source: '7 · 2a-1',
        confidence: 'guess',
        // Marked unverified, so the listing redacts its text.
        verified: false,
      });

      const listed = (await tools.oa_memory_list.execute({}, ctx)) as {
        entries: { text: string }[];
        pending: number;
      };
      expect(listed.entries).toHaveLength(1);
      expect(listed.entries[0]?.text).toMatch(/^\[unverified: oa-mem-/);
      expect(listed.pending).toBe(2);
    } finally {
      await remove();
    }
  });

  it('decides on a candidate', async () => {
    const { root, remove } = await temporaryRoot();
    try {
      const { tools, store } = await toolsIn(root, [candidateRecord({ id: 7 })]);
      const decided = (await tools.oa_memory_decide.execute(
        { recordId: 7, decision: 'approve', decidedBy: 'daniel' },
        ctx,
      )) as { ok: boolean; state: string };
      expect(decided.ok).toBe(true);
      expect(decided.state).toBe('promoted');
      expect(await store.entries()).toHaveLength(1);
    } finally {
      await remove();
    }
  });
});
