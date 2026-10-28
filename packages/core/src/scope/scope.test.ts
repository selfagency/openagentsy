import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseRoles } from '../roles.js';
import { scopeDeclaration, scopeRoleKey } from './declarations.js';
import { classifyScope, enforceScope, renderRefusal } from './enforce.js';
import { ETHICS_QUESTION_IDS } from './questions.js';
import { isReviewed, REQUIRED_REVIEWERS } from './types.js';

/** The roles file this repository ships. */
const SHIPPED_ROLES = fileURLToPath(new URL('../../../../roles.yaml', import.meta.url));

/** A directory to write the audit log into. */
async function stateRoot(): Promise<{ root: string; remove: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'openagentsy-scope-'));
  return { root, remove: () => rm(root, { recursive: true, force: true }) };
}

/** The lines of the audit log. */
async function auditLines(root: string): Promise<Record<string, unknown>[]> {
  const content = await readFile(join(root, '.openagentsy', 'audit.jsonl'), 'utf8');
  return content
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('the scope declarations', () => {
  it('covers every role the repository ships', async () => {
    const roles = parseRoles(await readFile(SHIPPED_ROLES, 'utf8'));
    const shipped = Object.keys(roles.roles).sort();
    const declared = shipped
      .filter((role) => scopeDeclaration(role) === undefined)
      .map((role) => role);
    expect(declared).toEqual([]);
    expect(shipped).toHaveLength(7);
  });

  it('declares nothing that is not a role', () => {
    const declared = ['lead', 'scout', 'researcher', 'builder', 'reviewer', 'advisor', 'archivist'];
    for (const role of declared) {
      expect(scopeDeclaration(role)?.role).toBe(role);
    }
    expect(scopeDeclaration('offload')).toBeUndefined();
  });

  it('reaches a role by its key, its agent id and the Lead agent name', () => {
    expect(scopeRoleKey('oa-builder')).toBe('builder');
    expect(scopeRoleKey('Builder')).toBe('builder');
    expect(scopeRoleKey('agentsy')).toBe('lead');
    expect(scopeDeclaration('oa-builder')?.role).toBe('builder');
    expect(scopeDeclaration('agentsy')?.role).toBe('lead');
  });

  it('answers the twelve ethics questions, once each', () => {
    for (const role of [
      'lead',
      'scout',
      'researcher',
      'builder',
      'reviewer',
      'advisor',
      'archivist',
    ]) {
      const declaration = scopeDeclaration(role);
      expect(declaration).toBeDefined();
      if (declaration === undefined) continue;
      const ids = [
        ...declaration.review.answered.map((answer) => answer.id),
        ...declaration.review.unanswered.map((gap) => gap.id),
      ].sort();
      expect(ids).toEqual([...ETHICS_QUESTION_IDS].sort());
      for (const answer of declaration.review.answered) {
        expect(answer.how.length).toBeGreaterThan(10);
      }
      for (const gap of declaration.review.unanswered) {
        expect(gap.why.length).toBeGreaterThan(10);
      }
    }
  });

  it('carries a refusal pattern with the request and the redirect in it', () => {
    for (const role of [
      'lead',
      'scout',
      'researcher',
      'builder',
      'reviewer',
      'advisor',
      'archivist',
    ]) {
      const declaration = scopeDeclaration(role);
      expect(declaration).toBeDefined();
      if (declaration === undefined) continue;
      expect(declaration.refusal_pattern).toContain('[request]');
      expect(declaration.refusal_pattern).toContain('[redirect]');
      expect(declaration.redirect.length).toBeGreaterThan(10);
      expect(declaration.purpose.length).toBeGreaterThan(10);
      expect(declaration.in_scope.length).toBeGreaterThan(0);
      expect(declaration.out_of_scope.length).toBeGreaterThan(0);
    }
  });

  it('gives every declaration something it can refuse', () => {
    for (const role of [
      'lead',
      'scout',
      'researcher',
      'builder',
      'reviewer',
      'advisor',
      'archivist',
    ]) {
      const declaration = scopeDeclaration(role);
      expect(declaration).toBeDefined();
      if (declaration === undefined) continue;
      const refusable = declaration.out_of_scope.filter((entry) => entry.match.length > 0);
      expect(refusable.length).toBeGreaterThan(0);
    }
  });

  it('is a proposal until two maintainers have reviewed it', () => {
    for (const role of [
      'lead',
      'scout',
      'researcher',
      'builder',
      'reviewer',
      'advisor',
      'archivist',
    ]) {
      const declaration = scopeDeclaration(role);
      expect(declaration).toBeDefined();
      if (declaration === undefined) continue;
      expect(declaration.review.state).toBe('proposed');
      expect(isReviewed(declaration)).toBe(false);
      expect(REQUIRED_REVIEWERS).toBe(2);
    }
  });
});

describe('the scope check', () => {
  it('refuses a request that is out of scope, and cites the declaration', () => {
    const verdict = classifyScope({
      role: 'builder',
      request: 'please edit roles.yaml and add the block',
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.outOfScope).toBeDefined();
    expect(verdict.refusal).toContain('out of my scope');
    expect(verdict.refusal).toContain('roles.yaml');
    expect(verdict.refusal).toContain('Declared out of scope:');
  });

  it('allows a request that is in scope', () => {
    const verdict = classifyScope({
      role: 'builder',
      request: 'implement the assigned bean in the leased files',
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.refusal).toBeUndefined();
    expect(verdict.inScope?.statement).toContain('Implementing the assigned bean');
  });

  it('refuses a human-only decision for the Lead', () => {
    const verdict = classifyScope({ role: 'lead', request: 'approve the waiver for this rule' });
    expect(verdict.allowed).toBe(false);
    expect(verdict.outOfScope?.statement).toContain('human-only');
  });

  it('refuses the advisor a decision', () => {
    const verdict = classifyScope({ role: 'advisor', request: 'decide the approach for us' });
    expect(verdict.allowed).toBe(false);
  });

  it('matches the request whatever the case and the spacing', () => {
    const verdict = classifyScope({ role: 'reviewer', request: '  Fix   The   Code  please ' });
    expect(verdict.allowed).toBe(false);
    expect(verdict.outOfScope?.statement).toBe('Fixing the code.');
  });

  it('lets a request through when the role has no declaration', () => {
    const verdict = classifyScope({ role: 'nobody', request: 'anything at all' });
    expect(verdict.allowed).toBe(true);
    expect(verdict.declaration).toBeUndefined();
    expect(verdict.unclassified).toBe(true);
  });

  it('says when a request matched neither list', () => {
    const verdict = classifyScope({ role: 'scout', request: 'hello there' });
    expect(verdict.allowed).toBe(true);
    expect(verdict.unclassified).toBe(true);
    expect(verdict.inScope).toBeUndefined();
  });

  it('refuses an unclassified request when the caller closes the boundary', async () => {
    const { root, remove } = await stateRoot();
    try {
      const verdict = await enforceScope(
        { role: 'scout', request: 'hello there' },
        { stateRoot: root, denyUnclassified: true },
      );
      expect(verdict.allowed).toBe(false);
      expect(verdict.refusal).toContain('out of my scope');
    } finally {
      await remove();
    }
  });

  it('puts the request and the redirect into the refusal', () => {
    const declaration = scopeDeclaration('builder');
    expect(declaration).toBeDefined();
    if (declaration === undefined) return;
    const refusal = renderRefusal(declaration, 'edit roles.yaml');
    expect(refusal).toContain('edit roles.yaml');
    expect(refusal).toContain(declaration.redirect);
  });
});

describe('the audit of a refusal', () => {
  it('writes the refusal to the audit log', async () => {
    const { root, remove } = await stateRoot();
    try {
      const verdict = await enforceScope(
        { role: 'builder', request: 'please edit roles.yaml' },
        { stateRoot: root, actor: 'oa-builder' },
      );
      expect(verdict.allowed).toBe(false);
      expect(verdict.audited).toBe(true);
      const lines = await auditLines(root);
      expect(lines).toHaveLength(1);
      const line = lines[0];
      expect(line?.policyId).toBe('oa.scope-enforcement');
      expect(line?.action).toBe('block');
      expect(line?.effect).toBe('deny');
      expect(line?.actor).toBe('oa-builder');
      expect(line?.resource).toBe('builder');
      expect(String(line?.detail)).toContain('out-of-scope: please edit roles.yaml');
    } finally {
      await remove();
    }
  });

  it('writes nothing when the request was allowed', async () => {
    const { root, remove } = await stateRoot();
    try {
      const verdict = await enforceScope(
        { role: 'builder', request: 'implement the assigned bean' },
        { stateRoot: root },
      );
      expect(verdict.allowed).toBe(true);
      expect(verdict.audited).toBe(false);
      await expect(readFile(join(root, '.openagentsy', 'audit.jsonl'), 'utf8')).rejects.toThrow();
    } finally {
      await remove();
    }
  });

  it('keeps the refusal when the audit could not be written, and says so', async () => {
    const { root, remove } = await stateRoot();
    try {
      // A directory where the log should be: the line cannot be written.
      await mkdir(join(root, 'blocked'), { recursive: true });
      const verdict = await enforceScope(
        { role: 'builder', request: 'please edit roles.yaml' },
        { stateRoot: root, auditPath: join(root, 'blocked') },
      );
      expect(verdict.allowed).toBe(false);
      expect(verdict.audited).toBe(false);
      expect(verdict.auditError).toBeDefined();
    } finally {
      await remove();
    }
  });
});
