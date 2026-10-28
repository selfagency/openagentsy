import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { gitFreeEnv } from '@openagentsy/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SERVER = fileURLToPath(new URL('../dist/index.js', import.meta.url));

/**
 * The roles file the board knows the agents by.
 *
 * The worktree carries its own copy, because a worktree is a checkout of the
 * branch: the roles file is a project file, and a project file belongs to
 * the workspace.
 */
const ROLES = `version: 1
protectedPaths: []
defaults:
  permissions: {}
roles:
  lead:
    agentName: agentsy
    description: Plans the work
    mode: primary
    writes: false
    scope: the plan
    guidance: delegate
    permissions: {}
    skills: []
    modelProfile:
      primarySignal: agentic
      hardRequirements: [tool_calls]
      costStance: quality_first
    effort:
      startVariant: medium
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

/** The task configuration of a project. */
const BEANS = `project:
  name: worktree-test
beans:
  path: .beans
  prefix: oa-
  id_length: 4
`;

let main: string;
let worktree: string;
let worktreeClient: Client;
let mainClient: Client;

/**
 * A main checkout with a linked worktree beside it.
 *
 * The two directories are the whole point of the section: the worktree has a
 * git directory of its own and shares the common one with the main
 * checkout, and the state of a project belongs to the main checkout.
 */
async function repositoryWithWorktree(): Promise<{ main: string; worktree: string }> {
  const base = await mkdtemp(join(tmpdir(), 'openagentsy-mcp-wt-'));
  const mainDir = join(base, 'main');
  const worktreeDir = join(base, 'wt');
  await mkdir(mainDir, { recursive: true });

  const git = (args: string[], cwd: string): void => {
    execFileSync('git', args, { cwd, env: gitFreeEnv(), stdio: 'ignore' });
  };

  git(['init', '-q'], mainDir);
  git(['config', 'user.email', 'test@openagentsy.test'], mainDir);
  git(['config', 'user.name', 'test'], mainDir);
  // The machine's global config turns the fsmonitor on, and a repository
  // whose daemon is not running then answers "could not read IPC response"
  // to the commands that read the index. The global config also signs every
  // commit, and the signing agent of the machine is not available to a test.
  git(['config', 'core.fsmonitor', 'false'], mainDir);
  git(['config', 'commit.gpgsign', 'false'], mainDir);
  await writeFile(join(mainDir, 'roles.yaml'), ROLES, 'utf8');
  await writeFile(join(mainDir, '.beans.yml'), BEANS, 'utf8');
  await writeFile(join(mainDir, 'openagentsy.models.lock.json'), '{}\n', 'utf8');
  git(['add', '-A'], mainDir);
  git(['commit', '-q', '-m', 'seed'], mainDir);
  git(['worktree', 'add', '-q', '-b', 'feature/x', worktreeDir], mainDir);

  // The state directory exists in the worktree too, so a board that was
  // opened in the worktree would find a home there instead of failing to
  // open. The test then fails on the assertion that says where the board
  // is, which is the fact under test, and not on a database that could not
  // be opened.
  await mkdir(join(worktreeDir, '.openagentsy'), { recursive: true });

  return { main: mainDir, worktree: worktreeDir };
}

/**
 * A server rooted in a directory.
 *
 * The root is the session's own directory: the worktree for a builder, the
 * main checkout for the Lead.
 */
async function serverIn(root: string): Promise<Client> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.OPENAGENTSY_ROOT = root;
  // The board in a test has no key, so the classification tool says so
  // instead of calling a service.
  delete env.TYPESAFE_API_KEY;

  const client = new Client({ name: 'worktree-test', version: '0.1.0' });
  await client.connect(new StdioClientTransport({ command: 'node', args: [SERVER], env }));
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
  if (result.isError) throw new Error(`tool ${name} failed: ${text}`);
  return JSON.parse(text) as unknown;
}

beforeAll(async () => {
  const made = await repositoryWithWorktree();
  main = made.main;
  worktree = made.worktree;

  // The builder's server, rooted in the worktree, and the Lead's server,
  // rooted in the main checkout. They are two sessions of one project, and
  // they have to see one board.
  worktreeClient = await serverIn(worktree);
  mainClient = await serverIn(main);
}, 30_000);

afterAll(async () => {
  await worktreeClient.close();
  await mainClient.close();
});

describe('a server rooted in a worktree', () => {
  it('posts its records to the board the Lead reads', async () => {
    // The exit test (b) of section 3.9: a session in a worktree posts to
    // the board of the main repository, and the Lead's own server, rooted
    // in the main checkout, reads the record in its inbox.
    const posted = await call(worktreeClient, 'board_record', {
      op: 'post',
      bean: 'proj-42',
      from: 'lead',
      kind: 'status',
      action: 'A record posted from a worktree',
      state: 'the worktree session posted it',
      confidence: 'verified',
    });
    expect(posted.id).toBeTypeOf('number');

    // The Lead's server, rooted in the main checkout, finds it in its
    // inbox. A board of the worktree's own would not carry it.
    const inbox = await call(mainClient, 'board_record', { op: 'inbox', agent: 'lead' });
    const records = inbox.records as { bean: string; action: string }[];
    expect(records.some((record) => record.action === 'A record posted from a worktree')).toBe(
      true,
    );
  });

  it('has no board of its own in the worktree', async () => {
    // The state belongs to the main checkout, and a board in the worktree
    // would be the fork the section exists to close.
    await expect(readFile(join(worktree, '.openagentsy', 'board.sqlite'))).rejects.toThrow();
  });

  it('keeps the task files of the worktree in the worktree', async () => {
    // The exit test (c) of section 3.9: the task files are the workspace's,
    // because a task edit travels with the branch. The board is the main
    // repository's, and the tasks are not.
    const created = await call(worktreeClient, 'oa_task_create', {
      title: 'A task written in the worktree',
      type: 'feature',
    });
    expect(created.id).toBeTypeOf('string');

    // The file is in the worktree, beside the branch that will carry it.
    const file = await readFile(join(worktree, '.beans', created.path as string), 'utf8');
    expect(file).toContain('A task written in the worktree');

    // And the main checkout has none of it: the edit stays in the worktree
    // until it is merged.
    await expect(readFile(join(main, '.beans', created.path as string))).rejects.toThrow();
    const mainTasks = await call(mainClient, 'oa_task_list', {});
    const found = (mainTasks.tasks as { id: string }[]).some((task) => task.id === created.id);
    expect(found).toBe(false);
  });
});
