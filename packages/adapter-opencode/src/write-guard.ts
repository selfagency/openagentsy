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
 * Check a write against the leases, and record the decision.
 *
 * Throws when the write is refused, so the agent is told and the tool call
 * ends. The audit line is written before the block is reported, so a blocked
 * write is always on record.
 */
export async function guardWrite(
  root: string,
  toolName: string,
  args: unknown,
  agent: string | undefined,
): Promise<void> {
  if (!WRITE_TOOLS.has(toolName)) return;
  if (!agent) return;

  const path = targetPathOf(args);
  if (!path) return;

  const absolute = path.startsWith('/') ? path : `${root}/${path}`;
  const decision = await decideWrite(root, absolute, agent);
  const resource = absolute;

  if (decision.effect === 'deny') {
    await appendAudit(root, {
      policyId: 'oa.lease.write',
      policyVersion: 'v1',
      actor: agent,
      action: toolName,
      resource,
      effect: 'deny',
      detail: decision.reason,
    });
    await appendAudit(root, {
      policyId: 'oa.scope.violation',
      policyVersion: 'v1',
      actor: agent,
      action: toolName,
      resource,
      effect: 'deny',
      detail: decision.reason,
    });
    throw new Error(
      `OpenAgentsy blocked this write. ${decision.reason} Ask the Lead for a lease, then retry.`,
    );
  }

  await appendAudit(root, {
    policyId: 'oa.lease.write',
    policyVersion: 'v1',
    actor: agent,
    action: toolName,
    resource,
    effect: 'allow',
    detail: decision.reason,
  });
}
