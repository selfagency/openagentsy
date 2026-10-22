import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  grantLeases,
  type Lease,
  listLeases,
  migrate,
  openDatabase,
  writeLeaseSnapshot,
} from '@openagentsy/core';

const execFileAsync = promisify(execFile);

export type Fixture = {
  /** Files to write, keyed by path relative to the case directory. */
  files: Record<string, string>;
  /** Leases to grant, relative globs. */
  leases?: { agent: string; glob: string; bean?: string }[];
  /** The model the agent under test runs on. */
  model?: string;
};

export type CaseState = {
  root: string;
  leases: Lease[];
  auditPath: string;
  boardPath: string;
};

/**
 * Seed a case directory.
 *
 * The directory gets the agents, the plugin and the board, so the case runs
 * against the same wiring a real project has.
 */
export async function seedCase(
  root: string,
  fixture: Fixture,
  _options: { repoRoot: string },
): Promise<CaseState> {
  for (const [path, content] of Object.entries(fixture.files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }

  await execFileAsync('git', ['init', '-q'], { cwd: root });
  await execFileAsync('git', ['add', '-A'], { cwd: root });
  await execFileAsync(
    'git',
    [
      '-c',
      'user.email=eval@openagentsy.test',
      '-c',
      'user.name=eval',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '-m',
      'seed',
    ],
    { cwd: root },
  );

  const stateDir = join(root, '.openagentsy');
  await mkdir(stateDir, { recursive: true });

  const db = openDatabase(join(stateDir, 'board.sqlite'));
  migrate(db);
  for (const lease of fixture.leases ?? []) {
    grantLeases(db, {
      bean: lease.bean ?? 'eval-1',
      agent: lease.agent,
      globs: [lease.glob],
    });
  }
  const leases = listLeases(db);
  await writeLeaseSnapshot(join(stateDir, 'leases.json'), leases);
  db.close();

  return {
    root,
    leases,
    auditPath: join(stateDir, 'audit.jsonl'),
    boardPath: join(stateDir, 'board.sqlite'),
  };
}

/** The files a case may write, so the assertions can tell what changed. */
export async function readAudit(
  state: CaseState,
): Promise<
  { policyId: string; actor: string; action: string; resource: string; effect: string }[]
> {
  const { readFile } = await import('node:fs/promises');
  let text: string;
  try {
    text = await readFile(state.auditPath, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as never);
}

/** Every record the board holds, for the assertions on what an agent reported. */
export async function readRecords(
  state: CaseState,
): Promise<{ kind: string; from: string; bean: string; action: string; state: string }[]> {
  const db = openDatabase(state.boardPath);
  try {
    const rows = db
      .prepare(`SELECT kind, from_agent, bean, action, state FROM records ORDER BY id`)
      .all() as unknown as {
      kind: string;
      from_agent: string;
      bean: string;
      action: string;
      state: string;
    }[];
    return rows.map((row) => ({
      kind: row.kind,
      from: row.from_agent,
      bean: row.bean,
      action: row.action,
      state: row.state,
    }));
  } finally {
    db.close();
  }
}

/**
 * Wire a directory the way a real project is wired: the agents, the plugin,
 * the board server and the leases.
 *
 * The same wiring serves the safety cases and the token baseline, so the two
 * measure the same system.
 */
export async function prepare(
  root: string,
  fixture: Fixture,
  options: { repoRoot: string; boardFault?: string; headless?: boolean },
): Promise<CaseState> {
  const state = await seedCase(root, fixture, { repoRoot: options.repoRoot });

  // The case runs the same roles as the project, so the agents and the
  // permission map under test are the real ones. A headless run opens the
  // shell and the editor up: the Lead asks before it runs a command, and a
  // headless session has nobody to answer, so the tool call waits forever.
  // The lease guard runs before the permission check, so opening the editor
  // up does not weaken what the cases are about.
  const roles =
    options.headless === true
      ? await headlessRoles(options.repoRoot)
      : await readFile(join(options.repoRoot, 'roles.yaml'), 'utf8');
  await writeFile(join(root, 'roles.yaml'), roles, 'utf8');
  await copyFile(
    join(options.repoRoot, 'openagentsy.models.lock.json'),
    join(root, 'openagentsy.models.lock.json'),
  );

  await execFileAsync(
    'node',
    [
      join(options.repoRoot, 'packages', 'cli', 'dist', 'index.js'),
      'build',
      '--root',
      root,
      '--target',
      'v1',
    ],
    { cwd: root },
  );

  await mkdir(join(root, '.opencode', 'plugins'), { recursive: true });
  await copyFile(
    join(options.repoRoot, 'packages', 'adapter-opencode', 'dist', 'index.js'),
    join(root, '.opencode', 'plugins', 'openagentsy.js'),
  );
  // The judge agent, which has no tools and answers with one JSON object.
  await mkdir(join(root, '.opencode', 'agents'), { recursive: true });
  await copyFile(
    join(options.repoRoot, 'packages', 'evals', 'templates', 'judge.md'),
    join(root, '.opencode', 'agents', 'judge.md'),
  );

  await writeFile(
    join(root, 'opencode.json'),
    `${JSON.stringify(
      {
        mcp: {
          ...disabledGlobalServers(),
          openagentsy: {
            type: 'local',
            command: ['node', join(options.repoRoot, 'packages', 'mcp', 'dist', 'index.js')],
            environment: {
              OPENAGENTSY_ROOT: root,
              ...(options.boardFault !== undefined
                ? { OPENAGENTSY_FAULT: options.boardFault }
                : {}),
            },
            enabled: true,
          },
        },
        compaction: { auto: false, prune: false },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  return state;
}

/**
 * The MCP servers the machine already runs, switched off for the case.
 *
 * A session sends the tool schemas of every MCP server it can reach, and the
 * global ones are large. Seven of them, the GitHub one alone has sixty
 * tools, is most of the prompt of a case. The case only needs the board.
 */
function disabledGlobalServers(): Record<string, { enabled: false }> {
  const disabled: Record<string, { enabled: false }> = {};
  for (const path of globalConfigPaths()) {
    for (const name of mcpServerNames(path)) {
      if (name !== 'openagentsy') disabled[name] = { enabled: false };
    }
  }
  return disabled;
}

function globalConfigPaths(): string[] {
  const home = process.env.HOME ?? '';
  return [
    join(home, '.opencode', 'opencode.jsonc'),
    join(home, '.opencode', 'opencode.json'),
    join(home, '.config', 'opencode', 'opencode.jsonc'),
    join(home, '.config', 'opencode', 'opencode.json'),
  ];
}

/** The names of the MCP servers in one config file, without a full parse. */
function mcpServerNames(path: string): string[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const block = text.match(/"mcp"\s*:\s*\{/);
  if (!block) return [];

  const names: string[] = [];
  const body = text.slice(block.index ?? 0);
  const pattern = /"([A-Za-z0-9_-]+)"\s*:\s*\{/g;
  for (let match = pattern.exec(body); match !== null; match = pattern.exec(body)) {
    const name = match[1];
    if (name !== undefined) names.push(name);
    if (names.length > 64) break;
  }
  return names;
}

/**
 * The project roles, with the shell and the editor opened up for a headless
 * run.
 */
async function headlessRoles(repoRoot: string): Promise<string> {
  const { parse, stringify } = await import('yaml');
  const text = await readFile(join(repoRoot, 'roles.yaml'), 'utf8');
  const roles = parse(text) as {
    roles: Record<string, { permissions?: Record<string, unknown> }>;
  };

  for (const role of Object.values(roles.roles)) {
    // The shell and the editor are opened up: a headless session has nobody
    // to answer an "ask", and the tool call would wait for the whole timeout.
    for (const action of ['shell', 'edit']) {
      const permissions = role.permissions;
      if (!permissions) continue;
      const rules = permissions[action];
      if (Array.isArray(rules)) {
        permissions[action] = rules.map((rule) => ({ ...rule, effect: 'allow' }));
      } else if (typeof rules === 'string') {
        permissions[action] = 'allow';
      }
    }

    // The same goes for everything else that would ask. A read outside the
    // case directory hangs the case for ten minutes, and a web call hangs it
    // the same way. Denying them is faster than answering them.
    const permissions = role.permissions;
    if (permissions) {
      permissions.external_directory = 'allow';
      permissions.webfetch = 'deny';
      permissions.websearch = 'deny';
    }
  }

  return stringify(roles);
}
