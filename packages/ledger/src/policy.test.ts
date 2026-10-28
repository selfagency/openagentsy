import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { closeLedger, openLedger } from './db.js';
import {
  createPolicyFiringSink,
  policyFireCounts,
  policyFiringTotal,
  recordPolicyFiring,
  topPoliciesByFireCount,
} from './policy.js';

/**
 * The policy firing log (§21.3).
 *
 * The log is a store and not a memory: the rows are read back after the
 * ledger was closed and opened again.
 */

/** A ledger in a directory of its own. */
function ledger(): { root: string; db: ReturnType<typeof openLedger> } {
  const root = mkdtempSync(join(tmpdir(), 'openagentsy-policy-'));
  return { root, db: openLedger(root) };
}

describe('the policy firing log', () => {
  it('reads back what was written after the ledger was closed and opened again', () => {
    const { root, db } = ledger();
    recordPolicyFiring(db, {
      sessionId: 'ses_1',
      policyId: 'oa.anti-sycophancy',
      policyVersion: '1.0.0',
      layer: 4,
      action: 'flag',
      severity: 'warn',
      reason: 'praise',
      origin: 'first-party',
    });
    recordPolicyFiring(db, {
      sessionId: 'ses_1',
      policyId: 'oa.anti-sycophancy',
      policyVersion: '1.0.0',
      layer: 4,
      action: 'block',
      reason: 'high-risk domain',
      origin: 'first-party',
    });
    recordPolicyFiring(db, {
      sessionId: 'ses_2',
      policyId: 'oa.agi-framing',
      policyVersion: '1.2.0',
      layer: 4,
      action: 'allow',
      origin: 'external',
    });
    closeLedger(db);

    const again = openLedger(root);
    try {
      expect(policyFiringTotal(again)).toBe(3);
      const counts = topPoliciesByFireCount(again, 10);
      expect(counts[0]?.policyId).toBe('oa.anti-sycophancy');
      expect(counts[0]?.count).toBe(2);
      expect(counts[0]?.flags).toBe(1);
      expect(counts[0]?.blocks).toBe(1);
      expect(counts[0]?.versions).toEqual(['1.0.0']);
      expect(counts[1]?.policyId).toBe('oa.agi-framing');
      expect(counts[1]?.versions).toEqual(['1.2.0']);
    } finally {
      closeLedger(again);
    }
  });

  it('holds the version the policy carried when it fired', () => {
    const { db } = ledger();
    try {
      recordPolicyFiring(db, {
        sessionId: 'ses_1',
        policyId: 'oa.anti-sycophancy',
        policyVersion: '1.1.0',
        layer: 4,
        action: 'allow',
        origin: 'first-party',
      });
      const row = db
        .query('SELECT policy_version, session_id, action FROM policy_firing WHERE policy_id = ?')
        .get('oa.anti-sycophancy') as {
        policy_version: string;
        session_id: string;
        action: string;
      };
      expect(row.policy_version).toBe('1.1.0');
      expect(row.session_id).toBe('ses_1');
      expect(row.action).toBe('allow');
    } finally {
      closeLedger(db);
    }
  });

  it('marks a module a plugin brought as external', () => {
    const { db } = ledger();
    try {
      const sink = createPolicyFiringSink(db);
      sink.record({
        sessionId: 'ses_1',
        policyId: 'acme.no-warnings',
        policyVersion: '0.1.0',
        layer: 4,
        action: 'allow',
        origin: 'external',
      });
      const row = db
        .query('SELECT origin FROM policy_firing WHERE policy_id = ?')
        .get('acme.no-warnings') as {
        origin: string;
      };
      expect(row.origin).toBe('external');
    } finally {
      closeLedger(db);
    }
  });

  it('counts every policy the log holds a row for', () => {
    const { db } = ledger();
    try {
      recordPolicyFiring(db, {
        sessionId: 'ses_1',
        policyId: 'oa.agi-framing',
        policyVersion: '1.0.0',
        layer: 4,
        action: 'allow',
        origin: 'first-party',
      });
      expect(policyFireCounts(db).map((entry) => entry.policyId)).toEqual(['oa.agi-framing']);
    } finally {
      closeLedger(db);
    }
  });
});
