import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firstPartyPolicyModules, PolicyEngine, PolicyRegistry } from '@openagentsy/hooks';
import {
  closeLedger,
  createPolicyFiringSink,
  openLedger,
  topPoliciesByFireCount,
} from '@openagentsy/ledger';
import { describe, expect, it } from 'vitest';

/**
 * The firing log, from the engine to the ledger and back (§21.3).
 *
 * The engine writes through a sink and the ledger stores the rows, so the
 * log is a store: it is read back after the ledger was closed and opened
 * again.
 */
describe('the policy firing log', () => {
  it('holds the firings of a session after the ledger was reopened', () => {
    const root = mkdtempSync(join(tmpdir(), 'openagentsy-policy-engine-'));
    const db = openLedger(root);
    const registry = new PolicyRegistry(firstPartyPolicyModules({ workspace: root }));
    const engine = new PolicyEngine(registry, { sink: createPolicyFiringSink(db) });

    engine.evaluate({
      session: { id: 'ses_1', roleId: 'builder' },
      response: { text: 'You are absolutely right, this is a great point.' },
    });
    closeLedger(db);

    const again = openLedger(root);
    try {
      const counts = topPoliciesByFireCount(again, 10);
      const flagged = counts.find((entry) => entry.policyId === 'oa.anti-sycophancy');
      expect(flagged?.count).toBe(1);
      expect(flagged?.flags).toBe(1);
      expect(flagged?.versions).toEqual(['1.0.0']);

      const stack = again
        .query('SELECT reason, detail FROM policy_firing WHERE policy_id = ?')
        .get('oa.policy.stack') as { reason: string; detail: string } | null;
      expect(stack?.reason).toBe('stack-assembled');
      expect(stack?.detail).toContain('oa.anti-sycophancy');
    } finally {
      closeLedger(again);
    }
  });

  it('records the stack of a session once, and the decisions of it', () => {
    const root = mkdtempSync(join(tmpdir(), 'openagentsy-policy-engine-'));
    const db = openLedger(root);
    const registry = new PolicyRegistry(firstPartyPolicyModules({ workspace: root }));
    const engine = new PolicyEngine(registry, { sink: createPolicyFiringSink(db) });

    const context = {
      session: { id: 'ses_1', roleId: 'builder' },
      response: { text: 'The parser reads the file.' },
    };
    engine.evaluate(context);
    engine.evaluate(context);
    closeLedger(db);

    const again = openLedger(root);
    try {
      const stack = again
        .query('SELECT COUNT(*) AS total FROM policy_firing WHERE policy_id = ?')
        .get('oa.policy.stack') as { total: number };
      expect(stack.total).toBe(1);
      const total = again.query('SELECT COUNT(*) AS total FROM policy_firing').get() as {
        total: number;
      };
      expect(total.total).toBeGreaterThan(1);
    } finally {
      closeLedger(again);
    }
  });
});
