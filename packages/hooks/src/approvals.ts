import { randomUUID } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { mkdir, open, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { readPreToolCall } from './event.js';
import type { HandlerResult } from './registry.js';

/**
 * The approval gate.
 *
 * A destructive command needs a person. OpenCode's own permission prompt
 * cannot be answered from inside a plugin, so an approval is a grant on
 * disk: a person runs `/oa approve <callID>`, the grant is written down,
 * and the call it names goes through once.
 */

/** One grant. */
export interface ApprovalEntry {
  /** The call the grant covers. */
  callID: string;
  /** When the grant stops being valid, in milliseconds since the epoch. */
  expiresAt: number;
}

/** How long a grant lives when no other time is given. */
export const DEFAULT_APPROVAL_TTL_MS = 15 * 60 * 1000;

/** The grants, as they are written down. */
const EntrySchema = z.object({ callID: z.string(), expiresAt: z.number() });
const GrantsSchema = z.array(EntrySchema);

/** How long a writer waits for the lock, in milliseconds. */
const LOCK_TIMEOUT_MS = 2000;

/**
 * How old a lock must be before it is presumed abandoned.
 *
 * It is four times the wait, so a writer that is alive and slow is never
 * mistaken for a writer that died. The two bounds are apart on purpose: a
 * bound that is the same as the wait would take the lock away from a
 * writer that is still holding it.
 */
const STALE_LOCK_MS = LOCK_TIMEOUT_MS * 4;

/**
 * How often the lock is refreshed while the action runs, in milliseconds.
 *
 * The refresh is what makes a lock stale only when its owner died: a
 * writer that is slow keeps its lock alive.
 */
const HEARTBEAT_MS = STALE_LOCK_MS / 4;

/** The pause between two tries for the lock, in milliseconds. */
const LOCK_RETRY_MS = 5;

/**
 * The timings of the store.
 *
 * They are the defaults of a store; a test can shorten them.
 */
export interface ApprovalTiming {
  /** How long a writer waits for the lock. */
  timeoutMs?: number;
  /** How old a lock must be before it is presumed abandoned. */
  staleMs?: number;
  /** How often the lock is refreshed while the action runs. */
  heartbeatMs?: number;
}

/** The timings a store runs with. */
export type ResolvedTiming = Required<ApprovalTiming>;

/**
 * Where the grants live.
 *
 * The file sits in the state root next to the board, so every session of
 * the project reads the same grants. The path is a protected one: the file
 * is written by a person and by the gate, never by an agent.
 */
export function approvalsPath(stateRoot: string): string {
  return join(stateRoot, '.openagentsy', 'approvals.json');
}

/** The grants, and the gate that spends them. */
export interface ApprovalStore {
  /** Where the grants live. */
  readonly path: string;
  /** Whether a grant covers the call now. */
  isApproved(callID: string, now: number): Promise<boolean>;
  /** Grant the call. */
  approve(callID: string, now: number, ttlMs?: number): Promise<ApprovalEntry>;
  /** Spend the grant: it passes once and is gone. */
  consumeApproval(callID: string, now: number): Promise<boolean>;
}

/**
 * Whether an error is the one the file system raises for a code.
 */
function isFileError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

/**
 * A pause.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The lock that serialises a claim.
 *
 * Two calls that spend the same grant at the same time must not both pass,
 * so the read and the write of the store are one step under a lock file
 * that is created exclusively. The second caller waits and then finds the
 * grant gone.
 */
export async function withLock<T>(
  path: string,
  timing: ResolvedTiming,
  action: () => Promise<T>,
): Promise<T> {
  const lockPath = `${path}.lock`;
  await mkdir(dirname(lockPath), { recursive: true });
  const release = await acquireLock(lockPath, timing);
  const heartbeat = setInterval(() => {
    // The refresh is not awaited: the action is what matters, and a
    // refresh that fails leaves the lock as it was.
    void utimes(lockPath, new Date(), new Date()).catch(() => undefined);
  }, timing.heartbeatMs);
  heartbeat.unref?.();
  try {
    return await action();
  } finally {
    clearInterval(heartbeat);
    await release();
  }
}

/**
 * The lock file, taken.
 *
 * The file is created exclusively, so only one writer holds it, and it
 * carries the token of the writer that holds it, so a writer only gives
 * back its own lock.
 *
 * A writer that cannot take the lock waits. Whether the lock may be taken
 * over is decided once, when the lock is first seen: a lock that was
 * alive then is not taken away from the writer that holds it now. A
 * writer that waits for too long gives up with an error: the store is not
 * left open.
 */
async function acquireLock(lockPath: string, timing: ResolvedTiming): Promise<() => Promise<void>> {
  const deadline = Date.now() + timing.timeoutMs;
  const token = randomUUID();
  let seen = false;
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx');
      await handle.writeFile(token);
      await handle.close();
      return async () => {
        await releaseLock(lockPath, token);
      };
    } catch (error) {
      if (!isFileError(error, 'EEXIST')) throw error;
      if (!seen) {
        seen = true;
        await takeStaleLock(lockPath, timing);
      }
      if (Date.now() > deadline) {
        throw new Error(`the approval store is locked by another writer: ${lockPath}`);
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
}

/**
 * A stale lock is taken over, once.
 *
 * The taking over is exclusive: exactly one waiter may take a stale lock
 * over. The one that does not win waits and then fails cleanly, because
 * two approvals out of one stale lock is one approval too many.
 */
async function takeStaleLock(lockPath: string, timing: ResolvedTiming): Promise<void> {
  if (!(await isStale(lockPath, timing))) return;
  if (await reclaimStaleLock(lockPath, timing)) return;
  throw new Error(`the approval store is locked by another writer: ${lockPath}`);
}

/**
 * The lock is given back.
 *
 * The lock is moved to a private path with a rename, which is one atomic
 * step, and the token is read there: a lock that was taken away from this
 * writer and given to another one is not removed by mistake, and the lock
 * of the other writer is put back.
 */
async function releaseLock(lockPath: string, token: string): Promise<void> {
  const privatePath = `${lockPath}.release.${token}`;
  try {
    await rename(lockPath, privatePath);
  } catch (error) {
    if (isFileError(error, 'ENOENT')) return;
    throw error;
  }
  let content: string;
  try {
    content = await readFile(privatePath, 'utf8');
  } catch (error) {
    if (isFileError(error, 'ENOENT')) return;
    throw error;
  }
  if (content !== token) {
    // The lock is not this writer's: it goes back where it was.
    await rename(privatePath, lockPath).catch(() => undefined);
    return;
  }
  await rm(privatePath, { force: true });
}

/**
 * Whether a lock is old enough to be presumed abandoned.
 */
async function isStale(path: string, timing: ResolvedTiming): Promise<boolean> {
  try {
    const stats = await stat(path);
    return Date.now() - stats.mtimeMs > timing.staleMs;
  } catch (error) {
    if (isFileError(error, 'ENOENT')) return true;
    throw error;
  }
}

/**
 * A file that outlived its writer is removed.
 *
 * It answers whether the file was there to be removed.
 */
async function removeIfStale(path: string, timing: ResolvedTiming): Promise<boolean> {
  if (!(await isStale(path, timing))) return false;
  await rm(path, { force: true });
  return true;
}

/**
 * A stale lock is taken over.
 *
 * The taking over is exclusive: a second file says who is taking it
 * over, so two waiters do not move the lock at the same time. The
 * staleness is checked again under it, so a lock that a live writer took
 * in the meantime is left alone, and the lock is moved aside with a
 * rename, which is one atomic step: only one waiter moves it.
 *
 * It answers whether this waiter took the lock over: the one that does
 * not goes on to wait, and then fails.
 */
async function reclaimStaleLock(lockPath: string, timing: ResolvedTiming): Promise<boolean> {
  const reclaimPath = `${lockPath}.reclaim`;
  let handle: FileHandle;
  try {
    handle = await open(reclaimPath, 'wx');
  } catch (error) {
    if (isFileError(error, 'EEXIST')) {
      // An orphan reclaim file blocks every later reclaim, so it is
      // removed when it is old enough to be one, and the reclaim is tried
      // again.
      if (!(await removeIfStale(reclaimPath, timing))) return false;
      return reclaimStaleLock(lockPath, timing);
    }
    throw error;
  }
  try {
    if (!(await isStale(lockPath, timing))) return false;
    const aside = `${lockPath}.stale`;
    await rm(aside, { force: true });
    try {
      await rename(lockPath, aside);
    } catch (error) {
      if (isFileError(error, 'ENOENT')) return false;
      throw error;
    }
    await rm(aside, { force: true });
    return true;
  } finally {
    await handle.close();
    await rm(reclaimPath, { force: true });
  }
}

/**
 * The grants, without the ones that have run out.
 *
 * A file that is not there yet is no grants. A file that cannot be read,
 * or that holds something else, is an error: the error travels to the
 * caller, so a grant is never granted on top of a file that was not
 * understood.
 */
async function loadGrants(
  path: string,
  now: number,
): Promise<{ entries: ApprovalEntry[]; pruned: boolean }> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isFileError(error, 'ENOENT')) return { entries: [], pruned: false };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`the approval store at ${path} does not hold JSON`, { cause: error });
  }
  const result = GrantsSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`the approval store at ${path} does not hold a list of grants`);
  }
  const entries = result.data.filter((entry) => entry.expiresAt > now);
  return { entries, pruned: entries.length !== result.data.length };
}

/**
 * The grants, written down.
 *
 * The directory is made first: the file is the first thing in the state
 * root of a fresh project, and a write that fails on a missing directory
 * is a grant nobody can give.
 */
async function saveGrants(path: string, entries: ApprovalEntry[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
}

/**
 * The store of grants for one project.
 */
export function createApprovalStore(stateRoot: string, timing: ApprovalTiming = {}): ApprovalStore {
  const path = approvalsPath(stateRoot);
  const resolved: ResolvedTiming = {
    timeoutMs: timing.timeoutMs ?? LOCK_TIMEOUT_MS,
    staleMs: timing.staleMs ?? STALE_LOCK_MS,
    heartbeatMs: timing.heartbeatMs ?? HEARTBEAT_MS,
  };
  return {
    path,
    async isApproved(callID: string, now: number): Promise<boolean> {
      return withLock(path, resolved, async () => {
        const { entries, pruned } = await loadGrants(path, now);
        if (pruned) await saveGrants(path, entries);
        return entries.some((entry) => entry.callID === callID);
      });
    },
    async approve(callID: string, now: number, ttlMs = DEFAULT_APPROVAL_TTL_MS) {
      return withLock(path, resolved, async () => {
        const { entries } = await loadGrants(path, now);
        const entry: ApprovalEntry = { callID, expiresAt: now + ttlMs };
        const kept = entries.filter((held) => held.callID !== callID);
        await saveGrants(path, [...kept, entry]);
        return entry;
      });
    },
    async consumeApproval(callID: string, now: number): Promise<boolean> {
      return withLock(path, resolved, async () => {
        const { entries, pruned } = await loadGrants(path, now);
        const held = entries.find((entry) => entry.callID === callID);
        if (held === undefined) {
          if (pruned) await saveGrants(path, entries);
          return false;
        }
        await saveGrants(
          path,
          entries.filter((entry) => entry.callID !== callID),
        );
        return true;
      });
    },
  };
}

/**
 * The message of an error, when it has one.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The rule handler that asks for an approval.
 *
 * A command that matches needs a grant. A pattern is enough for a single
 * shape, and a matcher is enough for the shapes a pattern cannot say: the
 * flags of `rm` in any order, for example.
 *
 * A store that cannot be read passes nothing: the command is refused, and
 * the reason names the failure. A refusal is the safe answer, and the
 * failure is not swallowed: it is in the reason.
 */
export function approvalGate(
  matcher: RegExp | ((command: string) => boolean),
  store: ApprovalStore,
  now: () => number = Date.now,
): (event: unknown) => Promise<HandlerResult> {
  return async (event) => {
    const call = readPreToolCall(event);
    if (call === undefined || call.command === undefined) return { continue: true };
    const matches =
      typeof matcher === 'function' ? matcher(call.command) : matcher.test(call.command);
    if (!matches) return { continue: true };
    const callID = call.callID;
    if (callID !== undefined) {
      try {
        if (await store.consumeApproval(callID, now())) return { continue: true };
      } catch (error) {
        return {
          continue: false,
          reason: `The approval store could not be read, so the command is refused. ${describe(error)}`,
        };
      }
    }
    return {
      continue: false,
      reason: `A destructive command needs a person to approve it. The escape hatch is /oa approve <callID>${
        callID === undefined ? '' : ` (this call is ${callID})`
      }.`,
    };
  };
}
