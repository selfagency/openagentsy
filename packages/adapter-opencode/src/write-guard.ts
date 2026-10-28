import { isAbsolute, join } from 'node:path';
import { appendAudit, decideWrite } from './guard.js';
import { patchPaths } from './patch-paths.js';
import type { Roots } from './roots.js';

/**
 * The path a write is aimed at, in absolute form.
 *
 * The board joins a relative path with node's own resolver, so the guard
 * does the same: a string that starts with a slash is a path on Unix and
 * not one on Windows, and a Windows path joined by hand comes out as
 * nonsense.
 */
export function joinRoot(root: string, path: string): string {
  return isAbsolute(path) ? path : join(root, path);
}

/**
 * The write guard, the one rule the runtime applies.
 *
 * A write is allowed only when a lease covers the path and the lease belongs
 * to the agent asking. Every decision is on record: the refusals, and the
 * writes that were allowed, because a log that only holds the refusals
 * cannot answer "was this file ever written?".
 */

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
 * The paths a write tool touches.
 *
 * The apply_patch tool carries no path argument: it carries the patch, and
 * the paths live in its marker lines. A patch can name several files, and
 * every one of them has to be leased.
 */
export function targetPathsOf(toolName: string, args: unknown): string[] {
  if (toolName === 'apply_patch') {
    if (typeof args !== 'object' || args === null) return [];
    const patchText = (args as Record<string, unknown>).patchText;
    if (typeof patchText !== 'string' || patchText.length === 0) return [];
    return patchPaths(patchText);
  }
  const path = targetPathOf(args);
  return path === undefined ? [] : [path];
}

/**
 * Record one decision.
 *
 * The audit line is written before the block is reported, so a blocked write
 * is always on record.
 */
async function recordDecision(
  stateRoot: string,
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
  await appendAudit(stateRoot, {
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
 * Returns undefined when there is nothing to check: the tool is not a write.
 * The two runtimes differ in what they do with a refusal, not in the rule,
 * so the rule lives here.
 */
export async function checkWrite(
  roots: Roots,
  input: {
    toolName: string;
    path: string;
    agent: string;
    sessionID?: string | undefined;
  },
): Promise<{ effect: 'allow' | 'deny'; reason: string } | undefined> {
  const { toolName, path, agent, sessionID } = input;
  // A relative path is relative to the session's own directory, so it is
  // joined against the workspace.
  const absolute = joinRoot(roots.workspace, path);
  const decision = await decideWrite(roots, absolute, agent);

  if (decision.effect === 'deny') {
    await recordDecision(roots.stateRoot, {
      policyId: 'oa.lease.write',
      actor: agent,
      action: toolName,
      resource: absolute,
      effect: 'deny',
      detail: decision.reason,
      sessionID,
    });
    await recordDecision(roots.stateRoot, {
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

  await recordDecision(roots.stateRoot, {
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
