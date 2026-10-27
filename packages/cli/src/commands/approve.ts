import { join } from 'node:path';
import { appendAudit, POLICIES } from '@openagentsy/core';
import { createApprovalStore, DEFAULT_APPROVAL_TTL_MS } from '@openagentsy/hooks';

/**
 * The escape hatch: a person approves one call, and the call passes once.
 *
 * OpenCode's permission prompt cannot be answered from inside a plugin, so a
 * destructive command is refused with the id of the call it refused. The
 * person runs `/oa approve <callID>`, the grant is written down, and the
 * call it names goes through exactly once.
 *
 * The store is the one in `@openagentsy/hooks`: the lock, the pruning of the
 * grants that ran out and the one-shot consumption live there, and this
 * module is the thin layer a person drives it through. What it adds is the
 * audit: a grant and a use are both on the record, because an approval that
 * leaves no trace is an approval nobody can look at afterwards.
 */

/**
 * Where the audit of a project lives.
 *
 * It is the board's own log, beside the board: the same file the leases and
 * the records are audited in.
 */
function auditPath(root: string): string {
  return join(root, '.openagentsy', 'audit.jsonl');
}

/**
 * The actor of a grant: the person who ran the command.
 *
 * The grant is a human decision, and the board cannot tell who is calling it,
 * so the name of the person is what the person says it is. The default says
 * what it is without pretending to know more.
 */
const HUMAN = 'human';

/**
 * The longest a call id may be.
 *
 * The id comes from the host, so it is opaque, and the only thing a person
 * can get wrong is a whole command instead of an id.
 */
const MAX_CALL_ID = 200;

/** What the command was asked to do. */
export type ApproveOptions = {
  /** The project root: the state lives under it. */
  root: string;
  /** The call the grant covers, as the person typed it. */
  callID?: string | undefined;
  /** How long the grant lives, as the person typed it: milliseconds. */
  ttl?: string | undefined;
  /** The clock, so a test can move time. */
  now?: number | undefined;
  /** Who granted it. The person, unless the caller says otherwise. */
  actor?: string | undefined;
};

/** What the command did. */
export type ApproveResult =
  | { ok: true; outcome: 'granted'; callID: string; expiresAt: number }
  | { ok: true; outcome: 'already-granted'; callID: string }
  | { ok: false; outcome: 'no-call-id' | 'bad-ttl' | 'store-failed'; detail: string };

/**
 * Whether a string can be the id of a call.
 *
 * An id has no whitespace in it. A phrase, a path or a shell command is not
 * an id, and the gate names the id in the reason it gives, so the person
 * copies the id and not the sentence around it.
 */
function isCallID(text: string): boolean {
  return text.length > 0 && text.length <= MAX_CALL_ID && !/\s/.test(text);
}

/**
 * The lifetime a `--ttl` asks for, in milliseconds.
 *
 * The value is a number of milliseconds, and anything else is refused: a
 * grant that lives for an unknown time is a grant that lives for ever.
 */
function ttlOf(ttl: string): number | undefined {
  const text = ttl.trim();
  if (!/^\d+$/.test(text)) return undefined;
  const ms = Number(text);
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return ms;
}

/**
 * The message of an error, when it has one.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Grant a call the approval of a person.
 *
 * The grant is written down by the store, under its own lock, and the grant
 * is audited. A call that is already granted is reported as granted and
 * nothing is written: the store holds one entry per call, and a second grant
 * would only move the expiry of the one that is already there.
 */
export async function runApprove(options: ApproveOptions): Promise<ApproveResult> {
  const callID = options.callID ?? '';
  if (!isCallID(callID)) {
    return {
      ok: false,
      outcome: 'no-call-id',
      detail: 'pass the id of the call to approve: /oa approve <callID>',
    };
  }

  const ttlMs = options.ttl === undefined ? DEFAULT_APPROVAL_TTL_MS : ttlOf(options.ttl);
  if (ttlMs === undefined) {
    return {
      ok: false,
      outcome: 'bad-ttl',
      detail: 'the ttl is a number of milliseconds: /oa approve <callID> --ttl <ms>',
    };
  }

  const now = options.now ?? Date.now();
  try {
    const store = createApprovalStore(options.root);
    if (await store.isApproved(callID, now)) {
      return { ok: true, outcome: 'already-granted', callID };
    }
    const entry = await store.approve(callID, now, ttlMs);
    await appendAudit(auditPath(options.root), {
      policyId: POLICIES.approveGranted.id,
      policyVersion: POLICIES.approveGranted.version,
      actor: options.actor ?? HUMAN,
      action: 'approve',
      resource: callID,
      effect: 'allow',
      detail: `the grant runs out at ${new Date(entry.expiresAt).toISOString()}`,
    });
    return { ok: true, outcome: 'granted', callID, expiresAt: entry.expiresAt };
  } catch (error) {
    return {
      ok: false,
      outcome: 'store-failed',
      detail: `the approval store could not be written: ${describe(error)}`,
    };
  }
}

/** What the consumer of a grant needs to spend it. */
export type UseApprovalOptions = {
  /** The project root: the state lives under it. */
  root: string;
  /** The call the grant covers. */
  callID: string;
  /** The agent that made the call. */
  actor: string;
  /** The clock, so a test can move time. */
  now?: number | undefined;
};

/**
 * Spend a grant: the call passes once, and the use is on the record.
 *
 * The store spends the grant under its own lock, so two callers cannot both
 * pass the same call, and a grant that ran out is never spent. The use is
 * audited with the agent that made the call, because the person who granted
 * it is not the one that used it.
 *
 * The gate in `@openagentsy/hooks` spends a grant the same way, for a
 * consumer that keeps no trail of its own. This is the audited form of that
 * same step.
 */
export async function useApproval(options: UseApprovalOptions): Promise<boolean> {
  const store = createApprovalStore(options.root);
  const passed = await store.consumeApproval(options.callID, options.now ?? Date.now());
  if (!passed) return false;
  await appendAudit(auditPath(options.root), {
    policyId: POLICIES.approveUsed.id,
    policyVersion: POLICIES.approveUsed.version,
    actor: options.actor,
    action: 'approve_use',
    resource: options.callID,
    effect: 'allow',
    detail: 'the grant was spent',
  });
  return true;
}

/**
 * The report, as a person reads it.
 */
export function formatApproveResult(result: ApproveResult): string {
  if (!result.ok) return result.detail;
  if (result.outcome === 'already-granted') {
    return `${result.callID} is already approved. Nothing was changed.`;
  }
  return `approved ${result.callID} until ${new Date(result.expiresAt).toISOString()}`;
}
