import { join } from 'node:path';
import { appendAudit, POLICIES } from '@openagentsy/core';
import {
  type ApprovalGrant,
  createApprovalStore,
  DEFAULT_APPROVAL_TTL_MS,
} from '@openagentsy/hooks';

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
 *
 * The store and the audit are the state root's, so a grant given in a
 * worktree is a grant of the project.
 */

/**
 * Where the audit of a project lives.
 *
 * It is the board's own log, beside the board: the same file the leases and
 * the records are audited in.
 */
function auditPath(stateRoot: string): string {
  return join(stateRoot, '.openagentsy', 'audit.jsonl');
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

/**
 * The longest a grant may live, in milliseconds.
 *
 * A day is generous: long enough for a person to read the reason the gate
 * gave, answer it and let the agent retry, and short enough that a grant
 * left behind does not open a door days later. A longer window is refused
 * before anything is written, so a grant that never runs out cannot be
 * written at all.
 */
const MAX_TTL_MS = 24 * 60 * 60 * 1000;

/** What the command was asked to do. */
export type ApproveOptions = {
  /** The state root: the approvals store and the audit live under it. */
  stateRoot: string;
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
  | { ok: true; outcome: 'already-granted'; callID: string; expiresAt: number }
  | {
      ok: false;
      outcome: 'no-call-id' | 'bad-ttl' | 'store-failed' | 'audit-failed' | 'unaudited-grant';
      detail: string;
    };

/**
 * Whether a string can be the id of a call.
 *
 * An id has no whitespace in it, and it names no path: a phrase, a path or
 * a shell command is not an id, and the gate names the id in the reason it
 * gives, so the person copies the id and not the sentence around it. The
 * id is a JSON string today, and a charset that cannot name a path keeps it
 * one that cannot.
 */
function isCallID(text: string): boolean {
  if (text.length === 0 || text.length > MAX_CALL_ID) return false;
  if (/\s/.test(text)) return false;
  if (text.includes('/') || text.includes('\\')) return false;
  if (text.includes('..')) return false;
  return true;
}

/**
 * The lifetime a `--ttl` asks for, in milliseconds.
 *
 * The value is a number of milliseconds, and anything else is refused: a
 * grant that lives for an unknown time is a grant that lives for ever, and
 * so is one that lives for longer than a day.
 */
function ttlOf(ttl: string): number | undefined {
  const text = ttl.trim();
  if (!/^\d+$/.test(text)) return undefined;
  const ms = Number(text);
  if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_TTL_MS) return undefined;
  return ms;
}

/**
 * The message of an error, when it has one.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The grant a call gets, or the error that stopped it.
 */
type GrantAttempt = { grant: ApprovalGrant } | { error: unknown };

/**
 * The grant of a call, without throwing at the caller.
 *
 * The store holds its own lock, so the grant is written once: two people
 * approving the same call at the same time do not write it twice.
 */
async function grantCall(
  store: ReturnType<typeof createApprovalStore>,
  callID: string,
  now: number,
  ttlMs: number,
): Promise<GrantAttempt> {
  try {
    return { grant: await store.approve(callID, now, ttlMs) };
  } catch (error) {
    return { error };
  }
}

/**
 * Grant a call the approval of a person.
 *
 * The grant is written down by the store, under its own lock, and the grant
 * is audited. A call that is already granted is reported as granted and
 * nothing is written: the store holds one entry per call, and the grant that
 * is already there keeps the expiry it has.
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
      detail: `the ttl is a number of milliseconds, at most ${MAX_TTL_MS} (a day): /oa approve <callID> --ttl <ms>`,
    };
  }

  const now = options.now ?? Date.now();
  const store = createApprovalStore(options.stateRoot);
  const attempt = await grantCall(store, callID, now, ttlMs);
  if ('error' in attempt) {
    return {
      ok: false,
      outcome: 'store-failed',
      detail: `the approval store could not be written: ${describe(attempt.error)}`,
    };
  }

  const grant = attempt.grant;
  if (!grant.created) {
    return {
      ok: true,
      outcome: 'already-granted',
      callID,
      expiresAt: grant.entry.expiresAt,
    };
  }

  // The grant is on file, and the trail is part of the grant: a grant that
  // nobody can look at afterwards is a grant nobody gave.
  try {
    await appendAudit(auditPath(options.stateRoot), {
      policyId: POLICIES.approveGranted.id,
      policyVersion: POLICIES.approveGranted.version,
      actor: options.actor ?? HUMAN,
      action: 'approve',
      resource: callID,
      effect: 'allow',
      detail: `the grant runs out at ${new Date(grant.entry.expiresAt).toISOString()}`,
    });
  } catch (error) {
    // The grant was written and the trail was not. The grant is taken back,
    // so a call is never approved and not on the record at the same time.
    let taken = false;
    let failure: string | undefined;
    try {
      taken = await store.revokeApproval(callID, now);
    } catch (revokeError) {
      failure = describe(revokeError);
    }
    if (taken) {
      return {
        ok: false,
        outcome: 'audit-failed',
        detail: `the audit could not be written, so the grant was taken back: ${describe(error)}`,
      };
    }
    return {
      ok: false,
      outcome: 'unaudited-grant',
      detail: `the grant was written to ${store.path} but the audit could not be written: ${describe(error)}. The call is approved and it is not on the record.${
        failure === undefined ? '' : ` The grant could not be taken back either: ${failure}.`
      }`,
    };
  }

  return { ok: true, outcome: 'granted', callID, expiresAt: grant.entry.expiresAt };
}

/** What the consumer of a grant needs to spend it. */
export type UseApprovalOptions = {
  /** The state root: the approvals store lives under it. */
  stateRoot: string;
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
 * pass the same call, and a grant that ran out is never spent. The store
 * writes the trail of the spend with the agent that made the call, because
 * the person who granted it is not the one that used it.
 */
export async function useApproval(options: UseApprovalOptions): Promise<boolean> {
  const store = createApprovalStore(options.stateRoot);
  return store.consumeApproval(options.callID, options.now ?? Date.now(), options.actor);
}

/**
 * The report, as a person reads it.
 */
export function formatApproveResult(result: ApproveResult): string {
  if (!result.ok) return result.detail;
  const until = new Date(result.expiresAt).toISOString();
  if (result.outcome === 'already-granted') {
    return `${result.callID} is already approved until ${until}. Nothing was changed.`;
  }
  return `approved ${result.callID} until ${until}`;
}
