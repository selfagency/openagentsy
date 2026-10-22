import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export type AuditEffect = 'allow' | 'ask' | 'deny';

export type AuditEntry = {
  ts: string;
  policyId: string;
  policyVersion: string;
  actor: string;
  action: string;
  resource: string;
  effect: AuditEffect;
  detail?: string;
};

export type AuditInput = Omit<AuditEntry, 'ts'>;

/**
 * The policy registry. Every decision the board makes carries one of these
 * ids so an audit line can be traced back to the rule that produced it.
 */
export const POLICIES = {
  recordPost: { id: 'oa.record.post', version: 'v1' },
  leaseGrant: { id: 'oa.lease.grant', version: 'v1' },
  leaseDeny: { id: 'oa.lease.deny', version: 'v1' },
  budgetSet: { id: 'oa.budget.set', version: 'v1' },
  budgetStop: { id: 'oa.budget.stop', version: 'v1' },
} as const;

export async function appendAudit(path: string, entry: AuditInput): Promise<void> {
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, line, 'utf8');
}
