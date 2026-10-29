import { describe, expect, it } from 'vitest';
import { FIRST_PARTY_POLICY_IDS, firstPartyPolicyModules } from './policies/index.js';
import { PolicyRegistry } from './policy-registry.js';

/**
 * The selection of the policy stack (§21.4).
 *
 * The registry assembles the stack from the classification, and the
 * assembly is explainable: every module says why it is in the stack.
 */

/** The catalogue of the first-party policies. */
function registry(): PolicyRegistry {
  return new PolicyRegistry(
    firstPartyPolicyModules({ workspace: '/tmp/openagentsy-registry-test' }),
  );
}

describe('the policy registry', () => {
  it('gives every session the baseline stack and the always-on guardrails', () => {
    const selected = registry().select({});

    const ids = selected.map((module) => module.id);
    expect(ids).toContain('oa.truthfulness-uncertainty');
    expect(ids).toContain('oa.anti-sycophancy');
    expect(ids).toContain('oa.no-skip-git-hooks');
    expect(ids).not.toContain('oa.high-risk.advice');
  });

  it('adds the high-risk module of the domain the classification named', () => {
    const selected = registry().select({ highRiskDomain: 'advice', confidence: 0.9 });

    const ids = selected.map((module) => module.id);
    expect(ids).toContain('oa.high-risk.advice');
    expect(ids).not.toContain('oa.high-risk.crime');
  });

  it('says why each module was selected', () => {
    const selection = registry().explain({ highRiskDomain: 'relational' });

    const reason = (id: string): string | undefined =>
      selection.reasons.find((entry) => entry.policyId === id)?.reason;
    expect(reason('oa.no-skip-git-hooks')).toBe('the guardrail applies to every tool call');
    expect(reason('oa.anti-sycophancy')).toBe('every session gets this policy');
    expect(reason('oa.high-risk.relational')).toBe(
      'the classification named the relational domain',
    );
    expect(reason('oa.high-risk.advice')).toBeUndefined();
  });

  it('carries the version of every module it selected', () => {
    const selection = registry().explain({});

    for (const entry of selection.reasons) {
      expect(entry.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('runs a module a plugin brought, and marks it external', () => {
    const candidate = {
      id: 'acme.no-warnings',
      version: '0.1.0',
      layer: 4,
      description: 'A module a downstream project brought.',
      appliesTo: ['PreResponse'],
      evaluate: () => ({ action: 'allow' }),
    };
    const registry = PolicyRegistry.withPlugins(firstPartyPolicyModules({ workspace: '/tmp/ws' }), [
      candidate,
    ]);

    const selected = registry.select({});
    const module = selected.find((entry) => entry.id === 'acme.no-warnings');
    expect(module?.origin).toBe('external');
  });

  it('drops a candidate that is not a policy', () => {
    const registry = PolicyRegistry.withPlugins(firstPartyPolicyModules({ workspace: '/tmp/ws' }), [
      { id: 'acme.broken', version: 'not-a-version' },
      'nonsense',
    ]);

    expect(registry.select({}).map((module) => module.id)).not.toContain('acme.broken');
  });

  it('holds every first-party policy of §21.2 with an id and a version', () => {
    const modules = firstPartyPolicyModules({ workspace: '/tmp/ws' });

    const ids = modules.map((module) => module.id);
    for (const id of FIRST_PARTY_POLICY_IDS) {
      expect(ids).toContain(id);
    }
    expect(new Set(ids).size).toBe(ids.length);
    for (const module of modules) {
      expect(module.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(module.origin).toBe('first-party');
    }
  });
});
