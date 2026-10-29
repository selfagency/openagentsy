import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createScopeTools, SCOPE_TOOL_NAME } from './scope.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openagentsy-scope-mcp-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** The body of an answer. */
function body(result: { content: { type: 'text'; text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
}

/** The declaration an answer carries. */
function declarationOf(answer: Record<string, unknown>): {
  purpose: string;
  in_scope: string[];
  out_of_scope: string[];
  refusal_pattern: string;
  redirect: string;
} {
  return answer.declaration as {
    purpose: string;
    in_scope: string[];
    out_of_scope: string[];
    refusal_pattern: string;
    redirect: string;
  };
}

describe('the scope tool', () => {
  it('is named the way the other tools are named', () => {
    expect(SCOPE_TOOL_NAME).toBe('oa_scope');
  });

  it('says what it does, and that it decides nothing', () => {
    const tools = createScopeTools({ workspace: root });
    expect(tools.oa_scope.description).toContain('scope');
    expect(tools.oa_scope.description).toContain('decides nothing');
  });

  it('returns the declaration of one role', async () => {
    const tools = createScopeTools({ workspace: root });
    const result = await tools.oa_scope.handler({ role: 'lead' });
    expect(result.isError).toBeUndefined();
    const answer = body(result);
    expect(answer.found).toBe(true);
    expect(answer.role).toBe('lead');
    const declaration = declarationOf(answer);
    expect(declaration.purpose).toContain('Coordinate');
    expect(Array.isArray(declaration.in_scope)).toBe(true);
    expect(Array.isArray(declaration.out_of_scope)).toBe(true);
    expect(declaration.refusal_pattern).toContain('[request]');
    expect(declaration.redirect.length).toBeGreaterThan(0);
  });

  it('reaches a role by its agent id', async () => {
    const tools = createScopeTools({ workspace: root });
    const result = await tools.oa_scope.handler({ role: 'oa-builder' });
    expect(body(result).role).toBe('builder');
  });

  it('returns every role when no role is named', async () => {
    const tools = createScopeTools({ workspace: root });
    const result = await tools.oa_scope.handler({});
    const answer = body(result);
    const roles = answer.roles as { role: string }[];
    expect(roles.map((entry) => entry.role).sort()).toEqual([
      'advisor',
      'archivist',
      'builder',
      'lead',
      'offload',
      'researcher',
      'reviewer',
      'scout',
    ]);
  });

  it('says so honestly when a role has no scope', async () => {
    const tools = createScopeTools({ workspace: root });
    const result = await tools.oa_scope.handler({ role: 'nobody' });
    expect(result.isError).toBeUndefined();
    const answer = body(result);
    expect(answer.found).toBe(false);
    expect(String(answer.message)).toContain('no scope declared');
  });

  it('prefers the block the project pasted into its roles file', async () => {
    await writeFile(
      join(root, 'roles.yaml'),
      [
        'version: 1',
        'roles:',
        '  lead:',
        '    description: The Lead.',
        '    mode: primary',
        '    writes: false',
        '    scope:',
        '      purpose: The scope this project gave the Lead.',
        '      in_scope:',
        '        - read the board',
        '      out_of_scope:',
        '        - write code',
        '      refusal_pattern: "I am the Lead. [request] is out of my scope. [redirect]."',
        '      redirect: Ask a person.',
        '    guidance: Coordinate.',
        '    modelProfile:',
        '      primarySignal: agentic',
        '      costStance: balanced',
        '    effort:',
        '      startVariant: standard',
        '      ceilingVariant: standard',
        '',
      ].join('\n'),
      'utf8',
    );
    const tools = createScopeTools({ workspace: root });
    const result = await tools.oa_scope.handler({ role: 'lead' });
    const answer = body(result);
    expect(answer.source).toBe('roles.yaml');
    const declaration = declarationOf(answer);
    expect(declaration.purpose).toBe('The scope this project gave the Lead.');
  });

  it('says so honestly when the project has no roles file', async () => {
    const tools = createScopeTools({ workspace: root });
    const result = await tools.oa_scope.handler({ role: 'lead' });
    expect(body(result).found).toBe(true);
  });
});
