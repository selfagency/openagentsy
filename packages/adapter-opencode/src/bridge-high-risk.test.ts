import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeLedger, openLedger } from '@openagentsy/ledger';
import { describe, expect, it } from 'vitest';
import { createBridge } from './bridge.js';

/**
 * The high-risk row of a reply (§20.3).
 *
 * The classifier fires on a reply that touches a high-risk domain, and the
 * guard path leaves a row behind: one row, under the id of the domain, with
 * the domain and the evidence in it. The reply is flagged and not stopped, so
 * a person decides what the flag means.
 */

/** A row of the firing log. */
interface FiringRow {
  policy_id: string;
  action: string;
  severity: string | null;
  reason: string | null;
  classification: string | null;
  session_id: string;
}

/** A reply that touches the advice domain. */
const HIGH_RISK_REPLY =
  'Should I take this medication for my chest pain, and can I claim the interest on my student loan as a tax deduction?';

/** A reply that touches no domain. */
const QUIET_REPLY = 'The parser reads the file and returns the tree.';

/** A workspace and a state root of their own. */
async function roots(): Promise<{ workspace: string; stateRoot: string }> {
  const base = await mkdtemp(join(tmpdir(), 'oa-high-risk-'));
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
        'SELECT policy_id, action, severity, reason, classification, session_id FROM policy_firing ORDER BY rowid',
      )
      .all() as FiringRow[];
  } finally {
    closeLedger(db);
  }
}

/** The rows of the high-risk family. */
function highRiskRows(stateRoot: string): FiringRow[] {
  return rows(stateRoot).filter((row) => row.policy_id.startsWith('oa.high-risk.'));
}

describe('the high-risk reply', () => {
  it('writes one row for the domain and flags the reply', async () => {
    const { workspace, stateRoot } = await roots();
    const findings: { name: string; type: string }[] = [];
    const bridge = createBridge({
      workspace,
      stateRoot,
      onFindings: (found) => {
        findings.push(...found);
      },
    });
    const output = { text: HIGH_RISK_REPLY };

    await bridge['experimental.text.complete']({ sessionID: 'ses_1' }, output);

    // One row, under the id of the domain, and it is a flag.
    const high = highRiskRows(stateRoot);
    expect(high).toHaveLength(1);
    expect(high[0]).toMatchObject({
      policy_id: 'oa.high-risk.advice',
      action: 'flag',
      severity: 'warn',
      classification: 'advice',
      session_id: 'ses_1',
    });
    // The reason names the domain and the evidence that found it.
    expect(high[0]?.reason).toContain('advice');
    expect(high[0]?.reason).toContain('medication');

    // The reply is flagged: the finding is handed over and the reply says so.
    expect(findings.map((finding) => finding.name)).toContain('high-risk');
    expect(output.text).toContain('high-risk');
  });

  it('writes no row for a reply that touches no domain', async () => {
    const { workspace, stateRoot } = await roots();
    const findings: { name: string; type: string }[] = [];
    const bridge = createBridge({
      workspace,
      stateRoot,
      onFindings: (found) => {
        findings.push(...found);
      },
    });
    const output = { text: QUIET_REPLY };

    await bridge['experimental.text.complete']({ sessionID: 'ses_1' }, output);

    expect(highRiskRows(stateRoot)).toEqual([]);
    expect(findings).toEqual([]);
    expect(output.text).toBe(QUIET_REPLY);
  });
});
