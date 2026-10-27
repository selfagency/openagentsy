import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
 * The grants, without the ones that have run out.
 *
 * A file that cannot be read, or that holds something else, is no grants:
 * a gate that cannot read its grants refuses the call, which is the answer
 * that keeps the destructive command out.
 */
async function loadGrants(
  path: string,
  now: number,
): Promise<{ entries: ApprovalEntry[]; pruned: boolean }> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return { entries: [], pruned: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { entries: [], pruned: false };
  }
  const result = GrantsSchema.safeParse(parsed);
  if (!result.success) return { entries: [], pruned: false };
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
      const { entries, pruned } = await loadGrants(path, now);
      if (pruned) await saveGrants(path, entries);
      return entries.some((entry) => entry.callID === callID);
    },
    async approve(callID: string, now: number, ttlMs = DEFAULT_APPROVAL_TTL_MS) {
      const { entries } = await loadGrants(path, now);
      const entry: ApprovalEntry = { callID, expiresAt: now + ttlMs };
      const kept = entries.filter((held) => held.callID !== callID);
      await saveGrants(path, [...kept, entry]);
      return entry;
    },
    async consumeApproval(callID: string, now: number): Promise<boolean> {
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
    },
  };
}

/**
 * The rule handler that asks for an approval.
 *
 * A command that matches the pattern needs a grant. A grant that covers
 * the call is spent and the call goes on; without one the call is stopped,
 * and the reason names the way out.
 */
export function approvalGate(
  pattern: RegExp,
  store: ApprovalStore,
  now: () => number = Date.now,
): (event: unknown) => Promise<HandlerResult> {
  return async (event) => {
    const call = readPreToolCall(event);
    if (call === undefined || call.command === undefined) return { continue: true };
    if (!pattern.test(call.command)) return { continue: true };
    const callID = call.callID;
    if (callID !== undefined && (await store.consumeApproval(callID, now()))) {
      return { continue: true };
    }
    return {
      continue: false,
      reason: `A destructive command needs a person to approve it. The escape hatch is /oa approve <callID>${
        callID === undefined ? '' : ` (this call is ${callID})`
      }.`,
    };
  };
}
