import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ProjectRoots } from '@openagentsy/core';
import { describe, expect, it } from 'vitest';
import { formatAuditReport, runAudit } from './audit.js';
import { runWaiver } from './waivers.js';

const exec = promisify(execFile);

/** The two roots of a project that is its own state root. */
function rootsOf(root: string): ProjectRoots {
  return { workspace: root, stateRoot: root };
}

/** A stylesheet with a floor finding: the page root clips its overflow. */
const FLOOR_CSS = 'html {\n  overflow-x: hidden;\n}\n';

/** A stylesheet with a reflex finding: a colour written out instead of a token. */
const REFLEX_CSS = '.chip {\n  color: #ff0000;\n}\n';

/** A project to audit: a directory with a source directory in it. */
async function project(): Promise<{ root: string; remove: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'openagentsy-cli-audit-'));
  await mkdir(join(root, 'src'), { recursive: true });
  return { root, remove: () => rm(root, { recursive: true, force: true }) };
}

/**
 * The git variables that point a command at a repository.
 *
 * A git that runs a hook sets these in the environment of the hook, and a
 * child inherits them: the child then addresses the repository of the hook
 * instead of the one it was asked about, and a test that writes into the
 * repository of the hook writes into the project. The variables are
 * removed, so the repository is the one the test named.
 */
const GIT_REPOSITORY_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_PREFIX',
  'GIT_NAMESPACE',
];

/** The environment of a git child: the caller's, without the git variables. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (GIT_REPOSITORY_VARS.includes(key)) continue;
    env[key] = value;
  }
  return env;
}

/**
 * The git of a test project.
 *
 * The fsmonitor hook is off, as it is in the command: the hook of a
 * machine whose daemon is not running answers with an error, and the
 * scope would come back empty.
 */
async function git(root: string, args: string[]): Promise<void> {
  await exec('git', ['-c', 'core.fsmonitor=false', ...args], { cwd: root, env: cleanEnv() });
}

/** A project with a commit in it, so the changed scope has a base. */
async function repository(): Promise<string> {
  const { root } = await project();
  await git(root, ['init', '-q']);
  await git(root, [
    '-c',
    'user.email=test@example.com',
    '-c',
    'user.name=Test',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'base',
  ]);
  return root;
}

describe('the audit command', () => {
  it('lists the findings of the scope', async () => {
    const root = await repository();
    try {
      await writeFile(join(root, 'src/app.css'), FLOOR_CSS);
      await git(root, ['add', 'src/app.css']);

      const report = await runAudit(rootsOf(root));

      expect(report.scope).toBe('changed');
      expect(report.files).toContain('src/app.css');
      expect(report.floor).toBe(1);
      const text = formatAuditReport(report);
      expect(text).toContain('css/overflow-clip');
      expect(text).toContain('src/app.css:2');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('prints the path that ran', async () => {
    const { root, remove } = await project();
    try {
      await writeFile(join(root, 'src/app.ts'), 'export const value = 1;\n');

      const report = await runAudit(rootsOf(root), { scope: 'all' });

      // The scope holds no page and no stylesheet, so the linter had
      // nothing to read and the static rules ran alone.
      expect(report.path).toBe('static');
      expect(report.degraded).toBe('no-files');
      expect(formatAuditReport(report)).toContain('static');
    } finally {
      await remove();
    }
  });

  it('a waived finding is not counted as open', async () => {
    const { root, remove } = await project();
    try {
      await writeFile(join(root, 'src/theme.css'), REFLEX_CSS);
      const waiver = await runWaiver(
        root,
        'css/token-only-colour-font',
        'src/theme.css',
        'The file is a fixture, not a page.',
      );
      expect(waiver.ok).toBe(true);

      const report = await runAudit(rootsOf(root), { scope: 'all' });

      expect(report.reflex).toBe(0);
      expect(report.waived.length).toBe(1);
      expect(report.waived[0]?.ruleId).toBe('css/token-only-colour-font');
      expect(report.exitCode).toBe(0);
      expect(formatAuditReport(report)).toContain('waived');
    } finally {
      await remove();
    }
  });

  it('the exit code follows the floor rule', async () => {
    const { root, remove } = await project();
    try {
      await writeFile(join(root, 'src/app.css'), FLOOR_CSS);
      await writeFile(join(root, 'src/theme.css'), REFLEX_CSS);

      const report = await runAudit(rootsOf(root), { scope: 'all' });

      expect(report.floor).toBe(1);
      expect(report.reflex).toBe(1);
      expect(report.exitCode).toBe(1);
    } finally {
      await remove();
    }
  });

  it('passes when only reflex findings are open', async () => {
    const { root, remove } = await project();
    try {
      await writeFile(join(root, 'src/theme.css'), REFLEX_CSS);

      const report = await runAudit(rootsOf(root), { scope: 'all' });

      expect(report.floor).toBe(0);
      expect(report.reflex).toBe(1);
      expect(report.exitCode).toBe(0);
    } finally {
      await remove();
    }
  });

  it('reads the after mode', async () => {
    const { root, remove } = await project();
    try {
      await writeFile(
        join(root, 'openagentsy.jsonc'),
        '{\n  // the check runs on the command, not on every write\n  "quality": { "mode": "after" }\n}\n',
      );

      const report = await runAudit(rootsOf(root), { scope: 'all' });

      expect(report.mode).toBe('after');
      const text = formatAuditReport(report);
      expect(text).toContain('after');
      expect(text).toContain('the hook is off');
    } finally {
      await remove();
    }
  });

  it('runs the check on every write by default', async () => {
    const { root, remove } = await project();
    try {
      const report = await runAudit(rootsOf(root), { scope: 'all' });

      expect(report.mode).toBe('during');
      expect(formatAuditReport(report)).toContain('during');
    } finally {
      await remove();
    }
  });
});
