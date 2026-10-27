import { mkdir, mkdtemp, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { approvalGate, approvalsPath, createApprovalStore, withLock } from './approvals.js';
import type { HandlerResult } from './registry.js';

/** The reason a result carries, when it stops the call. */
function reasonOf(result: HandlerResult): string | undefined {
  return 'reason' in result ? result.reason : undefined;
}

/** Whether a result lets the call through. */
function continues(result: HandlerResult): boolean {
  return 'continue' in result ? result.continue : true;
}

/** A pause. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'oa-approvals-'));
});

describe('the approval store', () => {
  it('writes the grants under the state root and makes the directory', async () => {
    const store = createApprovalStore(root);
    expect(store.path).toBe(approvalsPath(root));
    await store.approve('call-1', 1000, 60_000);
    const raw = JSON.parse(await readFile(store.path, 'utf8'));
    expect(raw).toEqual([{ callID: 'call-1', expiresAt: 61_000 }]);
  });

  it('passes a granted call exactly once', async () => {
    const store = createApprovalStore(root);
    await store.approve('call-1', 1000, 60_000);
    expect(await store.isApproved('call-1', 2000)).toBe(true);
    expect(await store.consumeApproval('call-1', 2000)).toBe(true);
    expect(await store.consumeApproval('call-1', 2000)).toBe(false);
    expect(await store.isApproved('call-1', 2000)).toBe(false);
  });

  it('never passes an expired grant', async () => {
    const store = createApprovalStore(root);
    await store.approve('call-1', 1000, 500);
    expect(await store.isApproved('call-1', 2000)).toBe(false);
    expect(await store.consumeApproval('call-1', 2000)).toBe(false);
  });

  it('prunes the grants that have run out', async () => {
    const store = createApprovalStore(root);
    await store.approve('old', 1000, 500);
    await store.approve('new', 1000, 60_000);
    expect(await store.isApproved('new', 2000)).toBe(true);
    const raw = JSON.parse(await readFile(store.path, 'utf8'));
    expect(raw).toEqual([{ callID: 'new', expiresAt: 61_000 }]);
  });

  it('holds no grant for a call nobody approved', async () => {
    const store = createApprovalStore(root);
    expect(await store.isApproved('call-1', 2000)).toBe(false);
  });

  it('spends a grant once, even when two callers race', async () => {
    const store = createApprovalStore(root);
    await store.approve('dup', 1000, 60_000);
    const results = await Promise.all([
      store.consumeApproval('dup', 2000),
      store.consumeApproval('dup', 2000),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('keeps the other grants when one is added', async () => {
    const store = createApprovalStore(root);
    await store.approve('first', 1000, 60_000);
    await store.approve('second', 1000, 60_000);
    const raw = JSON.parse(await readFile(store.path, 'utf8'));
    expect(raw).toHaveLength(2);
  });

  it('does not take a lock that a live writer holds', async () => {
    const store = createApprovalStore(root);
    await mkdir(join(root, '.openagentsy'), { recursive: true });
    const lockPath = `${store.path}.lock`;
    await writeFile(lockPath, 'held', 'utf8');
    await expect(store.approve('call-1', 1000, 60_000)).rejects.toThrow('locked by another writer');
    expect(await readFile(lockPath, 'utf8')).toBe('held');
  });

  it('lets one writer take a stale lock over and refuses the other', async () => {
    const store = createApprovalStore(root, { timeoutMs: 50, staleMs: 200, heartbeatMs: 50 });
    await mkdir(join(root, '.openagentsy'), { recursive: true });
    const lockPath = `${store.path}.lock`;
    await writeFile(lockPath, 'held', 'utf8');
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    const results = await Promise.allSettled([
      store.approve('first', 1000, 60_000),
      store.approve('second', 1000, 60_000),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('takes a stale lock over even when a reclaim file was left behind', async () => {
    const store = createApprovalStore(root, { timeoutMs: 50, staleMs: 200, heartbeatMs: 50 });
    await mkdir(join(root, '.openagentsy'), { recursive: true });
    const lockPath = `${store.path}.lock`;
    await writeFile(lockPath, 'held', 'utf8');
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    const reclaimPath = `${lockPath}.reclaim`;
    await writeFile(reclaimPath, 'orphan', 'utf8');
    await utimes(reclaimPath, old, old);
    const entry = await store.approve('call-1', 1000, 60_000);
    expect(entry.callID).toBe('call-1');
  });

  it('takes a stale lock over even when a stale file was left behind', async () => {
    const store = createApprovalStore(root, { timeoutMs: 50, staleMs: 200, heartbeatMs: 50 });
    await mkdir(join(root, '.openagentsy'), { recursive: true });
    const lockPath = `${store.path}.lock`;
    await writeFile(lockPath, 'held', 'utf8');
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    const stalePath = `${lockPath}.stale`;
    await writeFile(stalePath, 'old', 'utf8');
    await utimes(stalePath, old, old);
    const entry = await store.approve('call-1', 1000, 60_000);
    expect(entry.callID).toBe('call-1');
  });

  it('refreshes the lock while the action runs', async () => {
    const path = approvalsPath(root);
    await mkdir(join(root, '.openagentsy'), { recursive: true });
    const timing = { timeoutMs: 50, staleMs: 200, heartbeatMs: 50 };
    await withLock(path, timing, async () => {
      await sleep(150);
      const stats = await stat(`${path}.lock`);
      expect(Date.now() - stats.mtimeMs).toBeLessThan(100);
    });
  });

  it('leaves no lock behind', async () => {
    const store = createApprovalStore(root);
    await store.approve('call-1', 1000, 60_000);
    const files = await readdir(join(root, '.openagentsy'));
    expect(files.filter((name) => name.startsWith('approvals.json.lock'))).toEqual([]);
  });

  it('takes over a lock that was left behind', async () => {
    const store = createApprovalStore(root);
    await mkdir(join(root, '.openagentsy'), { recursive: true });
    const lockPath = `${store.path}.lock`;
    await writeFile(lockPath, '', 'utf8');
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    const entry = await store.approve('call-1', 1000, 60_000);
    expect(entry.callID).toBe('call-1');
  });

  it('refuses to grant on a store it cannot read', async () => {
    const store = createApprovalStore(root);
    await mkdir(join(root, '.openagentsy'), { recursive: true });
    await writeFile(store.path, '{not json', 'utf8');
    await expect(store.approve('call-1', 1000, 60_000)).rejects.toThrow();
  });

  it('does not rewrite a store it cannot read', async () => {
    const store = createApprovalStore(root);
    await mkdir(join(root, '.openagentsy'), { recursive: true });
    await writeFile(store.path, '{not json', 'utf8');
    await expect(store.approve('call-1', 1000, 60_000)).rejects.toThrow();
    expect(await readFile(store.path, 'utf8')).toBe('{not json');
  });
});

describe('the approval gate', () => {
  it('stops a destructive command and names the escape hatch', async () => {
    const store = createApprovalStore(root);
    const gate = approvalGate(/rm\s+-rf/, store);
    const result = await gate({
      toolName: 'bash',
      args: {},
      files: [],
      command: 'rm -rf /',
      callID: 'call-7',
    });
    expect(continues(result)).toBe(false);
    expect(reasonOf(result)).toContain('/oa approve <callID>');
    expect(reasonOf(result)).toContain('call-7');
  });

  it('lets an approved call through once', async () => {
    const store = createApprovalStore(root);
    await store.approve('call-7', Date.now(), 60_000);
    const gate = approvalGate(/rm\s+-rf/, store);
    const first = await gate({
      toolName: 'bash',
      args: {},
      files: [],
      command: 'rm -rf /',
      callID: 'call-7',
    });
    expect(continues(first)).toBe(true);
    const second = await gate({
      toolName: 'bash',
      args: {},
      files: [],
      command: 'rm -rf /',
      callID: 'call-7',
    });
    expect(continues(second)).toBe(false);
  });

  it('lets a command that does not match through', async () => {
    const store = createApprovalStore(root);
    const gate = approvalGate(/rm\s+-rf/, store);
    const result = await gate({ toolName: 'bash', args: {}, files: [], command: 'ls -la' });
    expect(continues(result)).toBe(true);
  });

  it('refuses when the store cannot be read', async () => {
    const store = createApprovalStore(root);
    await mkdir(join(root, '.openagentsy'), { recursive: true });
    await writeFile(store.path, '{not json', 'utf8');
    const gate = approvalGate(/rm\s+-rf/, store);
    const result = await gate({
      toolName: 'bash',
      args: {},
      files: [],
      command: 'rm -rf /',
      callID: 'call-7',
    });
    expect(continues(result)).toBe(false);
    expect(reasonOf(result)).toContain('approval store');
  });
});
