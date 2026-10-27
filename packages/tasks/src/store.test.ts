import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { etagOf } from '@openagentsy/core';
import { describe, expect, it } from 'vitest';
import { EtagMismatch, TaskStore } from './store.js';
import { CircularDependencyError, InvalidStatusTransitionError } from './transitions.js';

/**
 * The store: the files, and the rules that write them.
 *
 * Every test writes to a directory of its own, because the store is the
 * only thing in the package that touches a filesystem, and a test that
 * shared one would be a test that could not run twice.
 */

/** A store, and the record of what it refused. */
interface Harness {
  store: TaskStore;
  root: string;
  audits: { kind: string; detail: string }[];
}

const harness = async (): Promise<Harness> => {
  const root = await mkdtemp(join(tmpdir(), 'oa-tasks-store-'));
  const beans = join(root, '.beans');
  await mkdir(beans, { recursive: true });
  const audits: { kind: string; detail: string }[] = [];
  const store = new TaskStore(beans, {
    prefix: 'oa-',
    onAudit: (kind, detail) => {
      audits.push({ kind, detail });
    },
  });
  return { store, root, audits };
};

describe('the store', () => {
  it('refuses to complete a task with an open floor finding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-tasks-floor-'));
    const beans = join(root, '.beans');
    await mkdir(beans, { recursive: true });
    const store = new TaskStore(beans, {
      prefix: 'oa-',
      openFloorFindings: () => [
        {
          ruleId: 'copy/unsourced-claim',
          file: 'src/page.html',
          line: 4,
          message: 'The copy makes a claim with no source.',
          fix: 'Cite where the claim comes from',
        },
      ],
    });
    const created = await store.create({ title: 'A task with a finding' });
    await store.update(created.id, { status: 'in-progress' });

    await expect(
      store.update(created.id, {
        status: 'completed',
        bodyMod: { append: '\n## Summary of Changes\n- did it\n' },
      }),
    ).rejects.toThrow(/open floor quality finding/);
    expect((await store.get(created.id))?.status).toBe('in-progress');
  });

  it('writes a new task and reads it back', async () => {
    const { store } = await harness();
    const created = await store.create({ title: 'A first task', type: 'bug' });
    expect(created.id.startsWith('oa-')).toBe(true);
    expect(created.slug).toBe('a-first-task');
    expect(created.status).toBe('todo');
    expect(created.etag).toHaveLength(16);

    const read = await store.get(created.id);
    expect(read?.title).toBe('A first task');
    expect(read?.type).toBe('bug');
  });

  it('gives the etag of the bytes on disk', async () => {
    const { store, root } = await harness();
    const created = await store.create({ title: 'A hashed task' });
    const bytes = await readFile(join(root, '.beans', created.path), 'utf8');
    expect(created.etag).toBe(etagOf(bytes));
  });

  it('changes a task and moves its updated_at', async () => {
    const { store } = await harness();
    const created = await store.create({ title: 'A changed task' });
    const updated = await store.update(created.id, { title: 'A renamed task' });
    expect(updated.title).toBe('A renamed task');
    expect((updated.updated_at ?? '') >= (created.updated_at ?? '')).toBe(true);
    expect(updated.etag).not.toBe(created.etag);
  });

  it('refuses a change that was written against another version', async () => {
    const { store } = await harness();
    const created = await store.create({ title: 'A guarded task' });
    await expect(store.update(created.id, { title: 'Clobbered' }, 'not-the-etag')).rejects.toThrow(
      EtagMismatch,
    );
  });

  it('takes a change that was written against the current version', async () => {
    const { store } = await harness();
    const created = await store.create({ title: 'A guarded task' });
    const updated = await store.update(created.id, { title: 'Accepted' }, created.etag);
    expect(updated.title).toBe('Accepted');
  });

  it('refuses a move the whitelist does not name, and says so', async () => {
    const { store, audits } = await harness();
    const created = await store.create({ title: 'A finished task' });
    await expect(store.update(created.id, { status: 'completed' })).rejects.toThrow(
      InvalidStatusTransitionError,
    );
    expect(audits).toEqual([
      { kind: 'oa.task.invalid_transition', detail: expect.stringContaining('todo to completed') },
    ]);
  });

  it('refuses a relation that would make a task depend on itself, and says so', async () => {
    const { store, audits } = await harness();
    const first = await store.create({ title: 'The first task' });
    const second = await store.create({ title: 'The second task', parent: first.id });

    let path: string[] = [];
    try {
      await store.update(first.id, { parent: second.id });
      throw new Error('the update should have been refused');
    } catch (error) {
      expect(error).toBeInstanceOf(CircularDependencyError);
      path = (error as CircularDependencyError).path;
    }
    expect(new Set(path)).toEqual(new Set([first.id, second.id]));
    expect(path[0]).toBe(path[path.length - 1]);
    expect(audits).toEqual([
      { kind: 'oa.task.cycle_detected', detail: expect.stringContaining('→') },
    ]);
  });

  it('archives the finished tasks', async () => {
    const { store, root } = await harness();
    const created = await store.create({ title: 'A done task', status: 'in-progress' });
    await store.update(created.id, {
      status: 'completed',
      bodyMod: { append: '## Summary of Changes\n\nIt works.' },
    });
    const archived = await store.archive();
    expect(archived).toEqual([created.id]);
    expect((await store.all()).map((task) => task.id)).toEqual([]);
    expect((await store.get(created.id))?.path).toBe(`archive/${created.path}`);
    expect(await readFile(join(root, '.beans', 'archive', created.path), 'utf8')).toContain(
      'Summary of Changes',
    );
  });
});

describe('the body changes', () => {
  it('replaces a text that appears once', async () => {
    const { store } = await harness();
    const created = await store.create({ title: 'A body task', body: 'the quick fox' });
    const updated = await store.update(created.id, {
      bodyMod: { replace: [{ old: 'quick', new: 'slow' }] },
    });
    expect(updated.body).toBe('the slow fox');
  });

  it('refuses a text that appears twice', async () => {
    const { store } = await harness();
    const created = await store.create({ title: 'A body task', body: 'alpha beta alpha' });
    await expect(
      store.update(created.id, { bodyMod: { replace: [{ old: 'alpha', new: 'x' }] } }),
    ).rejects.toThrow(/must be unique/);
  });

  it('refuses a text that is not there', async () => {
    const { store } = await harness();
    const created = await store.create({ title: 'A body task', body: 'alpha' });
    await expect(
      store.update(created.id, { bodyMod: { replace: [{ old: 'omega', new: 'x' }] } }),
    ).rejects.toThrow(/not in the body/);
  });

  it('refuses an empty text to replace', async () => {
    const { store } = await harness();
    const created = await store.create({ title: 'A body task', body: 'alpha' });
    await expect(
      store.update(created.id, { bodyMod: { replace: [{ old: '', new: 'x' }] } }),
    ).rejects.toThrow(/cannot be empty/);
  });

  it('appends after the replacements, with a blank line between', async () => {
    const { store } = await harness();
    const created = await store.create({ title: 'A body task', body: 'the quick fox' });
    const updated = await store.update(created.id, {
      bodyMod: {
        replace: [{ old: 'quick', new: 'slow' }],
        append: '## Summary of Changes\n\nIt works.',
      },
    });
    expect(updated.body).toBe('the slow fox\n\n## Summary of Changes\n\nIt works.');
  });

  it('writes nothing when one step of the change fails', async () => {
    const { store, root } = await harness();
    const created = await store.create({ title: 'A body task', body: 'alpha beta alpha' });
    const before = await readFile(join(root, '.beans', created.path), 'utf8');
    await expect(
      store.update(created.id, {
        bodyMod: { replace: [{ old: 'alpha', new: 'x' }], append: 'more' },
      }),
    ).rejects.toThrow();
    expect(await readFile(join(root, '.beans', created.path), 'utf8')).toBe(before);
  });
});
