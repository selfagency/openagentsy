import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  approvalGate,
  createApprovalStore,
  DEFAULT_APPROVAL_TTL_MS,
  type HandlerResult,
} from '@openagentsy/hooks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatApproveResult, runApprove, useApproval } from './approve.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openagentsy-approve-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** The grants the store holds, as they are written down. */
async function grants(): Promise<{ callID: string; expiresAt: number }[]> {
  const raw = await readFile(join(root, '.openagentsy', 'approvals.json'), 'utf8');
  return JSON.parse(raw) as { callID: string; expiresAt: number }[];
}

/** The audit lines the project holds. */
async function audit(): Promise<Record<string, unknown>[]> {
  const raw = await readFile(join(root, '.openagentsy', 'audit.jsonl'), 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The reason a result carries, when it stops the call. */
function reasonOf(result: HandlerResult): string | undefined {
  return 'reason' in result ? result.reason : undefined;
}

/** Whether a result lets the call through. */
function continues(result: HandlerResult): boolean {
  return 'continue' in result ? result.continue : true;
}

/** The call the gate refuses, with the command it refuses. */
function destructiveCall(callID: string): unknown {
  return {
    toolName: 'bash',
    args: {},
    files: [],
    command: 'rm -rf /',
    callID,
  };
}

describe('the approve command', () => {
  it('grants the call and writes the audit', async () => {
    const result = await runApprove({ root, callID: 'call-1', now: 1000 });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe('granted');
    expect(await grants()).toEqual([
      { callID: 'call-1', expiresAt: 1000 + DEFAULT_APPROVAL_TTL_MS },
    ]);
    const lines = await audit();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      policyId: 'oa.approve.granted',
      policyVersion: 'v1',
      actor: 'human',
      action: 'approve',
      resource: 'call-1',
      effect: 'allow',
    });
  });

  it('reports what it granted and when it runs out', async () => {
    const result = await runApprove({ root, callID: 'call-1', now: 1000 });

    expect(formatApproveResult(result)).toBe(
      `approved call-1 until ${new Date(1000 + DEFAULT_APPROVAL_TTL_MS).toISOString()}`,
    );
  });

  it('reports a call that is already granted and writes nothing twice', async () => {
    await runApprove({ root, callID: 'call-1', now: 1000 });

    const second = await runApprove({ root, callID: 'call-1', now: 2000 });

    expect(second.ok).toBe(true);
    expect(second.outcome).toBe('already-granted');
    expect(await grants()).toHaveLength(1);
    const lines = await audit();
    expect(lines.filter((line) => line['policyId'] === 'oa.approve.granted')).toHaveLength(1);
  });

  it('refuses a command with no call id', async () => {
    const result = await runApprove({ root });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('no-call-id');
    expect(formatApproveResult(result)).toContain('/oa approve <callID>');
  });

  it('refuses an argument that is not a call id', async () => {
    const result = await runApprove({ root, callID: 'rm -rf /' });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('no-call-id');
    expect(formatApproveResult(result)).toContain('/oa approve <callID>');
  });

  it('refuses a ttl that is not a number of milliseconds', async () => {
    const result = await runApprove({ root, callID: 'call-1', ttl: 'soon' });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('bad-ttl');
    expect(formatApproveResult(result)).toContain('--ttl <ms>');
  });

  it('grants a call for the ttl the person asked for', async () => {
    await runApprove({ root, callID: 'call-1', ttl: '60000', now: 1000 });

    expect(await grants()).toEqual([{ callID: 'call-1', expiresAt: 61_000 }]);
  });
});

describe('the one-shot approval', () => {
  it('lets the granted call through exactly once and refuses the second attempt', async () => {
    await runApprove({ root, callID: 'call-7', now: 1000 });
    const store = createApprovalStore(root);
    const gate = approvalGate(/rm\s+-rf/, store, () => 2000);

    const first = await gate(destructiveCall('call-7'));
    expect(continues(first)).toBe(true);
    expect(await grants()).toEqual([]);

    const second = await gate(destructiveCall('call-7'));
    expect(continues(second)).toBe(false);
    expect(reasonOf(second)).toContain('/oa approve <callID>');
  });

  it('spends the grant once and audits the use', async () => {
    await runApprove({ root, callID: 'call-7', now: 1000 });

    const spent = await useApproval({ root, callID: 'call-7', actor: 'oa-builder', now: 2000 });

    expect(spent).toBe(true);
    expect(await grants()).toEqual([]);
    const lines = await audit();
    const used = lines.filter((line) => line['policyId'] === 'oa.approve.used');
    expect(used).toHaveLength(1);
    expect(used[0]).toMatchObject({
      policyId: 'oa.approve.used',
      policyVersion: 'v1',
      actor: 'oa-builder',
      action: 'approve_use',
      resource: 'call-7',
      effect: 'allow',
    });
  });

  it('refuses a second use of the same grant', async () => {
    await runApprove({ root, callID: 'call-7', now: 1000 });
    await useApproval({ root, callID: 'call-7', actor: 'oa-builder', now: 2000 });

    const again = await useApproval({ root, callID: 'call-7', actor: 'oa-builder', now: 2000 });

    expect(again).toBe(false);
    const lines = await audit();
    expect(lines.filter((line) => line['policyId'] === 'oa.approve.used')).toHaveLength(1);
  });

  it('never passes a grant that ran out', async () => {
    await runApprove({ root, callID: 'call-7', ttl: '500', now: 1000 });
    const store = createApprovalStore(root);
    const gate = approvalGate(/rm\s+-rf/, store, () => 2000);

    const result = await gate(destructiveCall('call-7'));

    expect(continues(result)).toBe(false);
    expect(await useApproval({ root, callID: 'call-7', actor: 'oa-builder', now: 2000 })).toBe(
      false,
    );
  });
});
