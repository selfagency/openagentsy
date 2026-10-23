import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRoles } from '@openagentsy/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildLock, readLock } from './lock.js';
import type { Candidate, ProviderModel, RankEntry, Retention } from './types.js';

const SAFE: Retention = {
  trainsOnPrompts: false,
  zeroDataRetention: true,
  retentionDays: 0,
  source: 'test',
  checkedAt: '2026-10-22',
};

const ROLES = `
version: 1
protectedPaths: []
defaults:
  permissions: {}
roles:
  builder:
    description: Implements a bean
    mode: subagent
    writes: true
    scope: leased files
    guidance: test it
    permissions: {}
    skills: []
    modelProfile:
      primarySignal: coding
      hardRequirements: [tool_calls]
      costStance: balanced
    effort:
      startVariant: medium
      ceilingVariant: high
      ceilingModelRole: advisor
      climbTriggers: [test_failed_twice]
  advisor:
    description: Advises
    mode: subagent
    writes: false
    scope: advice
    guidance: recommend
    permissions: {}
    skills: []
    modelProfile:
      primarySignal: overall
      hardRequirements: [reasoning_variants]
      costStance: ignore_cost
    effort:
      startVariant: high
      ceilingVariant: high
      climbTriggers: []
  reviewer:
    description: Reviews
    mode: subagent
    writes: false
    scope: the diff
    guidance: report
    permissions: {}
    skills: []
    modelProfile:
      primarySignal: coding
      hardRequirements: [tool_calls]
      costStance: balanced
      differentCreatorThan: builder
    effort:
      startVariant: high
      ceilingVariant: high
      climbTriggers: []
`;

function model(overrides: Partial<ProviderModel> = {}): ProviderModel {
  return {
    provider: 'opencode-go',
    id: 'm',
    openCodeId: 'opencode-go/m',
    name: 'M',
    tools: true,
    thinking: true,
    vision: false,
    reasoning: true,
    variants: ['low', 'medium', 'high', 'xhigh', 'max'],
    contextWindow: 500_000,
    creator: 'Creator A',
    ...overrides,
  };
}

function rank(surface: 'overall' | 'coding', value: number): RankEntry {
  return {
    surface,
    rank: value,
    score: 100 - value,
    evidence: 'supported',
    scoreConfidence: 3,
    creator: 'Creator A',
  };
}

function candidate(openCodeId: string, overrides: Partial<Candidate> = {}): Candidate {
  return {
    model: model({ openCodeId, id: openCodeId.split('/')[1] ?? openCodeId }),
    ranks: { coding: rank('coding', 5), overall: rank('overall', 5) },
    retention: SAFE,
    ...overrides,
  };
}

/** One candidate per creator, so the cross family rule has something to pick. */
function pair(): Candidate[] {
  return [
    candidate('opencode-go/only', {
      model: model({ openCodeId: 'opencode-go/only', creator: 'Creator A' }),
    }),
    candidate('opencode-go/other', {
      model: model({ openCodeId: 'opencode-go/other', creator: 'Creator B' }),
      ranks: { coding: rank('coding', 9), overall: rank('overall', 9) },
    }),
  ];
}

describe('buildLock', () => {
  const roles = parseRoles(ROLES);

  it('picks a model for every role', () => {
    const { lock, failures } = buildLock({
      roles,
      candidates: pair(),
      providers: ['opencode-go'],
    });
    expect(Object.keys(lock.roles).sort()).toEqual(['advisor', 'builder', 'reviewer']);
    expect(failures).toEqual({});
  });

  it('reports a role it could not fill instead of throwing', () => {
    const { lock, failures } = buildLock({
      roles,
      candidates: [candidate('opencode-go/only')],
      providers: ['opencode-go'],
    });
    expect(failures.reviewer).toContain('same creator as the builder');
    expect(lock.roles.reviewer).toBeUndefined();
  });

  it('builds the ladder from the start variant to the ceiling', () => {
    const { lock } = buildLock({
      roles,
      candidates: pair(),
      providers: ['opencode-go'],
    });
    expect(lock.roles.builder?.ladder).toEqual([
      { model: 'opencode-go/only', variant: 'medium' },
      { model: 'opencode-go/only', variant: 'high' },
    ]);
  });

  it('uses the advisor model for the builder ceiling', () => {
    const { lock } = buildLock({
      roles,
      candidates: [
        candidate('opencode-go/builder-model', {
          model: model({ openCodeId: 'opencode-go/builder-model', creator: 'Creator A' }),
          ranks: { coding: rank('coding', 2), overall: rank('overall', 20) },
        }),
        candidate('opencode-go/advisor-model', {
          model: model({ openCodeId: 'opencode-go/advisor-model', creator: 'Creator B' }),
          ranks: { coding: rank('coding', 30), overall: rank('overall', 1) },
        }),
      ],
      providers: ['opencode-go'],
    });
    const builder = lock.roles.builder;
    if (!builder) throw new Error('no builder role');
    expect(builder.model).toBe('opencode-go/builder-model');
    expect(builder.ladder[1]).toEqual({ model: 'opencode-go/advisor-model', variant: 'high' });
  });

  it('keeps the reviewer on a different creator than the builder', () => {
    const { lock } = buildLock({
      roles,
      candidates: [
        candidate('opencode-go/builder-model', {
          model: model({ openCodeId: 'opencode-go/builder-model', creator: 'Creator A' }),
          ranks: { coding: rank('coding', 2), overall: rank('overall', 20) },
        }),
        candidate('opencode-go/reviewer-model', {
          model: model({ openCodeId: 'opencode-go/reviewer-model', creator: 'Creator B' }),
          ranks: { coding: rank('coding', 4), overall: rank('overall', 12) },
        }),
      ],
      providers: ['opencode-go'],
    });
    expect(lock.roles.builder?.model).toBe('opencode-go/builder-model');
    expect(lock.roles.reviewer?.model).toBe('opencode-go/reviewer-model');
  });

  it('gives a role one rung when the start and the ceiling are the same', () => {
    const { lock } = buildLock({
      roles,
      candidates: pair(),
      providers: ['opencode-go'],
    });
    expect(lock.roles.reviewer?.ladder).toEqual([{ model: 'opencode-go/other', variant: 'high' }]);
  });

  it('records why each model was chosen', () => {
    const { reasons } = buildLock({
      roles,
      candidates: pair(),
      providers: ['opencode-go'],
    });
    expect(reasons.builder).toContain('coding rank');
  });
});

describe('readLock', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'openagentsy-lock-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads a lock that fits the schema', async () => {
    const path = join(root, 'openagentsy.models.lock.json');
    await writeFile(
      path,
      JSON.stringify({
        generatedAt: 'now',
        providers: ['opencode-go'],
        roles: {
          builder: {
            model: 'opencode-go/builder',
            evidence: { source: 'test', label: 'supported', date: '2026-10-23' },
            ladder: [{ model: 'opencode-go/builder', variant: 'low' }],
          },
        },
      }),
      'utf8',
    );
    const lock = await readLock(path);
    expect(lock?.roles.builder?.model).toBe('opencode-go/builder');
  });

  it('reads a lock written by an older version', async () => {
    // The older lock has no providers and no evidence, and it is still a
    // lock a project can have.
    const path = join(root, 'openagentsy.models.lock.json');
    await writeFile(
      path,
      JSON.stringify({
        generatedAt: 'now',
        roles: { builder: { model: 'opencode-go/builder', ladder: [] } },
      }),
      'utf8',
    );
    const lock = await readLock(path);
    expect(lock?.roles.builder?.model).toBe('opencode-go/builder');
  });

  it('refuses a lock that does not fit the schema', async () => {
    // A cast would call this a lock. The schema says it is not one.
    const path = join(root, 'openagentsy.models.lock.json');
    await writeFile(path, JSON.stringify({ roles: { builder: { model: 42 } } }), 'utf8');
    expect(await readLock(path)).toBeUndefined();
  });
});
