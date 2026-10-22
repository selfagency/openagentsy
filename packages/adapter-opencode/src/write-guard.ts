import { appendAudit, decideWrite } from './guard.js';

/**
 * The write guard, the one rule both runtimes apply.
 *
 * A write is allowed only when a lease covers the path and the lease belongs
 * to the agent asking. Every decision is on record: the refusals, and the
 * writes that were allowed, because a log that only holds the refusals
 * cannot answer "was this file ever written?".
 */

const WRITE_TOOLS = new Set(['edit', 'write', 'patch', 'apply_patch']);

/** The path a write tool is aimed at, whatever the tool calls it. */
function targetPathOf(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const record = args as Record<string, unknown>;
  for (const key of ['filePath', 'path', 'file']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Record one decision.
 *
 * The audit line is written before the block is reported, so a blocked write
 * is always on record.
 */
async function recordDecision(
  root: string,
  entry: {
    actor: string;
    action: string;
    resource: string;
    effect: 'allow' | 'deny';
    detail: string;
    policyId: string;
    sessionID?: string | undefined;
  },
): Promise<void> {
  await appendAudit(root, {
    policyId: entry.policyId,
    policyVersion: 'v1',
    actor: entry.actor,
    action: entry.action,
    resource: entry.resource,
    effect: entry.effect,
    detail: entry.detail,
    sessionID: entry.sessionID,
  });
}

/**
 * Check a write against the leases, and record the decision.
 *
 * Returns undefined when there is nothing to check: the tool is not a write,
 * or the path is unknown. The two runtimes differ in what they do with a
 * refusal, not in the rule, so the rule lives here.
 */
export async function checkWrite(
  root: string,
  input: { toolName: string; path: string; agent: string; sessionID?: string | undefined },
): Promise<{ effect: 'allow' | 'deny'; reason: string } | undefined> {
  const { toolName, path, agent, sessionID } = input;
  const absolute = path.startsWith('/') ? path : `${root}/${path}`;
  const decision = await decideWrite(root, absolute, agent);

  if (decision.effect === 'deny') {
    await recordDecision(root, {
      policyId: 'oa.lease.write',
      actor: agent,
      action: toolName,
      resource: absolute,
      effect: 'deny',
      detail: decision.reason,
      sessionID,
    });
    await recordDecision(root, {
      policyId: 'oa.scope.violation',
      actor: agent,
      action: toolName,
      resource: absolute,
      effect: 'deny',
      detail: decision.reason,
      sessionID,
    });
    return { effect: 'deny', reason: decision.reason };
  }

  await recordDecision(root, {
    policyId: 'oa.lease.write',
    actor: agent,
    action: toolName,
    resource: absolute,
    effect: 'allow',
    detail: decision.reason,
    sessionID,
  });
  return { effect: 'allow', reason: decision.reason };
}

/**
 * Check a write against the leases, and record the decision.
 *
 * Throws when the write is refused, so the agent is told and the tool call
 * ends.
 */
export async function guardWrite(
  root: string,
  toolName: string,
  args: unknown,
  agent: string | undefined,
  sessionID?: string,
): Promise<void> {
  if (!WRITE_TOOLS.has(toolName)) return;
  if (!agent) return;

  const path = targetPathOf(args);
  if (!path) return;

  const result = await checkWrite(root, { toolName, path, agent, sessionID });
  if (result?.effect === 'deny') {
    throw new Error(
      `OpenAgentsy blocked this write. ${result.reason} Ask the Lead for a lease, then retry.`,
    );
  }
}
