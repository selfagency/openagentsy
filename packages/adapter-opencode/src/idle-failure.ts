import { appendAudit, POLICIES } from './guard.js';

/**
 * A failure of the idle path, on the record.
 *
 * The `event` hook is not awaited by OpenCode, so a throw there is a broken
 * session and not a failed check. The failure is written down and the
 * session goes on.
 *
 * Both paths use it: the V1 path reads the failure off the server client,
 * and the V2 path reads it off the event stream, and neither may let a
 * failed check take a session down.
 *
 * The audit log is the state root's: the failure is on the board of the
 * project, not on the disk of one worktree.
 */
export async function recordIdleFailure(
  stateRoot: string,
  input: { agent: string; sessionID: string; error: unknown },
): Promise<void> {
  try {
    await appendAudit(stateRoot, {
      policyId: POLICIES.eventsFailed.id,
      policyVersion: POLICIES.eventsFailed.version,
      actor: input.agent,
      action: 'idle',
      resource: input.sessionID,
      effect: 'deny',
      detail: input.error instanceof Error ? input.error.message : String(input.error),
      sessionID: input.sessionID,
    });
  } catch {
    // Nowhere left to record it. The session stays silent rather than throw.
  }
}
