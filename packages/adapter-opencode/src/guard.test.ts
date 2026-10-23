import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, grantLeases, migrate, openDatabase } from '@openagentsy/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { decideWrite, planClimb, readRungs, recordClimb, roleNameOf } from './guard.js';

let root: string;

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
      startVariant: low
      ceilingVariant: high
      climbTriggers: [test_failed_twice, touches_concurrency]
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
    effort:
      startVariant: high
      ceilingVariant: high
      climbTriggers: []
`;

const LOCK = {
  roles: {
    builder: {
      model: 'opencode-go/builder-model',
      ladder: [
        { model: 'opencode-go/builder-model', variant: 'low' },
        { model: 'opencode-go/ceiling-model', variant: 'high' },
      ],
    },
    reviewer: {
      model: 'opencode-go/reviewer-model',
      ladder: [{ model: 'opencode-go/reviewer-model', variant: 'high' }],
    },
  },
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openagentsy-adapter-'));
  await writeFile(join(root, 'roles.yaml'), ROLES, 'utf8');
  await writeFile(join(root, 'openagentsy.models.lock.json'), JSON.stringify(LOCK), 'utf8');
  await mkdir(join(root, '.openagentsy'), { recursive: true });
  const db = openDatabase(join(root, '.openagentsy', 'board.sqlite'));
  migrate(db);
  closeDatabase(db);
});

async function publishLease(agent: string, glob: string): Promise<void> {
  const db = openDatabase(join(root, '.openagentsy', 'board.sqlite'));
  grantLeases(db, { bean: 'proj-1', agent, globs: [glob] });
  closeDatabase(db);
}

describe('roleNameOf', () => {
  it('strips the agent prefix', () => {
    expect(roleNameOf('oa-builder')).toBe('builder');
  });

  it('leaves a name that is not prefixed alone', () => {
    expect(roleNameOf('build')).toBe('build');
  });
});

describe('decideWrite', () => {
  it('denies a write to a file no lease covers', async () => {
    await publishLease('oa-builder', 'src/**');
    const decision = await decideWrite(root, join(root, 'docs/app.ts'), 'oa-builder');
    expect(decision.effect).toBe('deny');
    expect(decision.reason).toContain('no lease covers');
  });

  it('allows a write to a file the agent holds', async () => {
    await publishLease('oa-builder', 'src/**');
    const decision = await decideWrite(root, join(root, 'src/app.ts'), 'oa-builder');
    expect(decision.effect).toBe('allow');
    expect(decision.owner).toBe('oa-builder');
  });

  it('denies a write to a file another agent holds', async () => {
    await publishLease('oa-builder-2', 'src/**');
    const decision = await decideWrite(root, join(root, 'src/app.ts'), 'oa-builder');
    expect(decision.effect).toBe('deny');
    expect(decision.owner).toBe('oa-builder-2');
    expect(decision.reason).toContain('leased to oa-builder-2');
  });

  it('denies a write when the board published no leases', async () => {
    const decision = await decideWrite(root, join(root, 'src/app.ts'), 'oa-builder');
    expect(decision.effect).toBe('deny');
    expect(decision.reason).toContain('no leases');
  });
});

describe('planClimb', () => {
  it('refuses a role that is not in the lock file', async () => {
    const plan = await planClimb(root, 'scout', 'test failed twice');
    expect(plan.ok).toBe(false);
    expect(plan.message).toContain('no model lock');
  });

  it('refuses a role that runs on one rung', async () => {
    const plan = await planClimb(root, 'reviewer', 'test failed twice');
    expect(plan.ok).toBe(false);
    expect(plan.message).toContain('one rung');
  });

  it('refuses a reason that names no trigger', async () => {
    const plan = await planClimb(root, 'builder', 'this feels hard');
    expect(plan.ok).toBe(false);
    expect(plan.message).toContain('must name a trigger');
  });

  it('accepts a reason that names a trigger in words', async () => {
    const plan = await planClimb(root, 'builder', 'the test failed twice already');
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error('the plan should be ok');
    expect(plan.rungIndex).toBe(1);
    expect(plan.target.model).toBe('opencode-go/ceiling-model');
  });

  it('refuses a second climb in a row', async () => {
    await recordClimb(root, 'builder', 1, 'the test failed twice');
    const plan = await planClimb(root, 'builder', 'the test failed twice');
    expect(plan.ok).toBe(false);
    expect(plan.message).toContain('ceiling');
  });

  it('records the rung so the next climb starts from it', async () => {
    await recordClimb(root, 'builder', 1, 'the test failed twice');
    const rungs = await readRungs(root);
    expect(rungs.builder?.rungIndex).toBe(1);
  });
});
