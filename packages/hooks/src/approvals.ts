import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
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

/** The pause between two tries for the lock, in milliseconds. */
const LOCK_RETRY_MS = 5;

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
async function withLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  await mkdir(dirname(lockPath), { recursive: true });
  const release = await acquireLock(lockPath);
  try {
    return await action();
  } finally {
    await release();
  }
}

/**
 * The lock file, taken.
 *
 * The file is created exclusively, so only one writer holds it. A writer
 * that cannot take it waits, and a writer that waits for too long gives
 * up with an error: the store is not left open.
 */
async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx');
      await handle.close();
      return async () => {
        await rm(lockPath, { force: true });
      };
    } catch (error) {
      if (!isFileError(error, 'EEXIST')) throw error;
      if (Date.now() > deadline) {
        throw new Error(`the approval store is locked by another writer: ${lockPath}`);
      }
      await sleep(LOCK_RETRY_MS);
    }
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
export function createApprovalStore(stateRoot: string): ApprovalStore {
  const path = approvalsPath(stateRoot);
  return {
    path,
    async isApproved(callID: string, now: number): Promise<boolean> {
      return withLock(path, async () => {
        const { entries, pruned } = await loadGrants(path, now);
        if (pruned) await saveGrants(path, entries);
        return entries.some((entry) => entry.callID === callID);
      });
    },
    async approve(callID: string, now: number, ttlMs = DEFAULT_APPROVAL_TTL_MS) {
      return withLock(path, async () => {
        const { entries } = await loadGrants(path, now);
        const entry: ApprovalEntry = { callID, expiresAt: now + ttlMs };
        const kept = entries.filter((held) => held.callID !== callID);
        await saveGrants(path, [...kept, entry]);
        return entry;
      });
    },
    async consumeApproval(callID: string, now: number): Promise<boolean> {
      return withLock(path, async () => {
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
