import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeDatabase,
  grantLeases,
  migrate,
  openDatabase,
  resolveStateRoot,
} from '@openagentsy/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decideWrite } from './guard.js';
import type { Roots } from './roots.js';

/**
 * The guard in a linked worktree (§3.9).
 *
 * A builder that works in a worktree writes files in the worktree, and the
 * board it asks for a lease lives in the main repository. The guard has to
 * read the board of the main repository, and it has to match a path against
 * the main root: a lease the Lead granted on the main board covers a file
 * in a worktree, and the file is the Lead's and not the builder's.
 */

const ROLES = `
version: 1
protectedPaths: []
defaults:
  permissions: {}
roles:
  lead:
    agentName: agentsy
    description: Runs the board
    mode: primary
    writes: false
    scope: the board
    guidance: report honestly
    permissions: {}
    skills: []
    modelProfile:
      primarySignal: coding
      hardRequirements: [tool_calls]
      costStance: balanced
    effort:
      startVariant: low
      ceilingVariant: high
      climbTriggers: [planning]
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
      climbTriggers: [test_failed_twice]
`;

let tmp: string;
/** The main repository: the directory that owns the state. */
let main: string;
/** The linked worktree: the directory the session works in. */
let worktree: string;

/** Run a git command in a directory, and fail loudly when it does not work. */
function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'commit.gpgsign',
      GIT_CONFIG_VALUE_0: 'false',
    },
  });
}

beforeEach(async () => {
  // The temp root is resolved before it is used. /var is a symlink to
  // /private/var on macOS, and the base the leases are matched against has
  // to share the spelling of the paths it is compared with: a root and a
  // path that differ only in that symlink are two different places.
  tmp = realpathSync(await mkdtemp(join(tmpdir(), 'openagentsy-worktree-guard-')));
  main = join(tmp, 'main');
  worktree = join(tmp, 'worktree');

  await mkdir(main, { recursive: true });
  git(main, ['init', '-q']);
  await writeFile(join(main, 'roles.yaml'), ROLES, 'utf8');
  git(main, ['add', 'roles.yaml']);
  git(main, [
    '-c',
    'commit.gpgsign=false',
    '-c',
    'user.email=builder@example.com',
    '-c',
    'user.name=Builder',
    'commit',
    '-q',
    '-m',
    'the roles of the project',
  ]);
  git(main, ['worktree', 'add', '-b', 'feature/guard', worktree]);
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/**
 * The board of the main repository, with the Lead's lease on the worktree.
 *
 * The lease is the absolute glob of the worktree, because that is how a
 * lease for a worktree is written: a path that sits outside the main root
 * is matched in its absolute form.
 */
async function boardWithTheLeadsLease(): Promise<string> {
  const stateRoot = resolveStateRoot(worktree);
  await mkdir(join(stateRoot, '.openagentsy'), { recursive: true });
  const db = openDatabase(join(stateRoot, '.openagentsy', 'board.sqlite'));
  try {
    migrate(db);
    grantLeases(db, { bean: '2e-1', agent: 'oa-lead', globs: [`${worktree}/**`] });
  } finally {
    closeDatabase(db);
  }
  return stateRoot;
}

describe('the guard in a linked worktree', () => {
  it('resolves the state root to the main repository', () => {
    // The worktree is a checkout of its own, and the state belongs to the
    // repository it was made from. A state root that pointed at the
    // worktree would be a board of its own, and the Lead would never see it.
    expect(resolveStateRoot(worktree)).toBe(main);
  });

  it('denies a builder the file the Lead leased on the main board', async () => {
    const stateRoot = await boardWithTheLeadsLease();
    const roots: Roots = { workspace: worktree, stateRoot };

    const decision = await decideWrite(roots, join(worktree, 'src/app.ts'), 'oa-builder');

    // The refusal is a conflict and not a gap: the lease of the Lead covers
    // the path, and it belongs to the Lead and not to the builder. A base
    // that was mis-routed to the workspace would relativise the path to
    // `src/app.ts`, match nothing, and answer "no lease covers" with no
    // owner and no glob. The owner and the glob are what give this test
    // its teeth.
    expect(decision.effect).toBe('deny');
    expect(decision.owner).toBe('oa-lead');
    expect(decision.glob).toBe(`${worktree}/**`);
    expect(decision.reason).toContain('leased to oa-lead');
  });

  it('allows the Lead the file it leased on the main board', async () => {
    // The other half of the same fact: the lease covers the path, so the
    // holder of the lease may write it. Without this, a guard that denied
    // everything would pass the test above.
    const stateRoot = await boardWithTheLeadsLease();
    const roots: Roots = { workspace: worktree, stateRoot };

    const decision = await decideWrite(roots, join(worktree, 'src/app.ts'), 'agentsy');

    expect(decision.effect).toBe('allow');
    expect(decision.owner).toBe('oa-lead');
  });
});
