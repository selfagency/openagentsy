import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OutputFinding } from '@openagentsy/hooks/output-checks';
import { closeLedger, openLedger } from '@openagentsy/ledger';
import { describe, expect, it } from 'vitest';
import { createBridge } from './bridge.js';

/**
 * The firing log of the live path (§21.3).
 *
 * The guard path decides, and every decision it takes leaves a row in the
 * ledger: the policy that decided, the version it carried at that moment,
 * what it did and the session it happened in. A row that is not written is
 * a decision nobody can account for, and these are the tests that hold the
 * bridge to that.
 */

/** A row of the firing log. */
interface FiringRow {
  policy_id: string;
  policy_version: string;
  action: string;
  severity: string | null;
  reason: string | null;
  session_id: string;
}

/** A workspace and a state root of their own. */
async function roots(): Promise<{ workspace: string; stateRoot: string }> {
  const base = await mkdtemp(join(tmpdir(), 'oa-firing-'));
  const workspace = join(base, 'workspace');
  const stateRoot = join(base, 'state');
  await mkdir(workspace, { recursive: true });
  await mkdir(stateRoot, { recursive: true });
  return { workspace, stateRoot };
}

/**
 * The rows the ledger holds.
 *
 * The ledger is read through a connection of its own, so the rows are the
 * ones the bridge wrote and not the ones it holds in memory.
 */
function rows(stateRoot: string): FiringRow[] {
  const db = openLedger(stateRoot);
  try {
    return db
      .query(
        'SELECT policy_id, policy_version, action, severity, reason, session_id FROM policy_firing ORDER BY rowid',
      )
      .all() as FiringRow[];
  } finally {
    closeLedger(db);
  }
}

describe('the firings of the guard path', () => {
  it('writes one row for a call it blocks', async () => {
    const { workspace, stateRoot } = await roots();
    const bridge = createBridge({ workspace, stateRoot });

    await expect(
      bridge['tool.execute.before'](
        { tool: 'bash', sessionID: 'ses_1', callID: 'call_1' },
        { args: { command: 'git commit --no-verify' } },
      ),
    ).rejects.toThrow(/Git hooks/);

    // The chain stops at the first rule that blocks, so the rule that
    // blocked is the only one that was asked.
    const found = rows(stateRoot);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      policy_id: 'oa.no-skip-git-hooks',
      policy_version: '1.0.0',
      action: 'block',
      session_id: 'ses_1',
    });
  });

  it('writes a row for every rule that was asked', async () => {
    const { workspace, stateRoot } = await roots();
    const bridge = createBridge({ workspace, stateRoot });

    await bridge['tool.execute.before'](
      { tool: 'bash', sessionID: 'ses_1', callID: 'call_1' },
      { args: { command: 'ls -la' } },
    );

    const found = rows(stateRoot);
    expect(found.map((row) => row.policy_id)).toEqual([
      'oa.no-skip-git-hooks',
      'oa.package-manager',
      'oa.workspace-writes-only',
      'oa.protect-policy',
      'oa.human-only-decisions',
      'oa.secret-scan-writes',
      'oa.destructive-needs-approval',
    ]);
    expect(found.every((row) => row.action === 'allow')).toBe(true);
    expect(found.every((row) => row.session_id === 'ses_1')).toBe(true);
  });

  it('writes one row for a reply it flags', async () => {
    const { workspace, stateRoot } = await roots();
    const findings: OutputFinding[] = [];
    const bridge = createBridge({
      workspace,
      stateRoot,
      onFindings: (found) => {
        findings.push(...found);
      },
    });

    await bridge['experimental.text.complete'](
      { sessionID: 'ses_1' },
      { text: 'You are absolutely right. That is a great point. I completely agree with you.' },
    );

    // One row for the evaluation, and not one row for every finding.
    const flags = rows(stateRoot).filter((row) => row.action === 'flag');
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      policy_id: 'oa.anti-sycophancy',
      policy_version: '1.0.0',
      severity: 'warn',
      session_id: 'ses_1',
    });
    // The reply still carries every finding.
    expect(findings.length).toBeGreaterThan(1);
  });

  it('records the refusal of a protected write with the policy that refused it', async () => {
    const { workspace, stateRoot } = await roots();
    const bridge = createBridge({ workspace, stateRoot });

    await expect(
      bridge['tool.execute.before'](
        { tool: 'write', sessionID: 'ses_1', callID: 'call_1' },
        { args: { filePath: join(workspace, 'roles.yaml'), content: 'x' } },
      ),
    ).rejects.toThrow(/changed by a person/);

    const blocks = rows(stateRoot).filter((row) => row.action === 'block');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      policy_id: 'oa.protect-policy',
      policy_version: '1.0.0',
    });
  });
});
