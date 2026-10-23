import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  closeDatabase,
  grantLeases,
  type Lease,
  listLeases,
  migrate,
  openDatabase,
  records,
  recordUsage,
  setBudget,
} from '@openagentsy/core';

const execFileAsync = promisify(execFile);

export type Fixture = {
  /** Files to write, keyed by path relative to the case directory. */
  files: Record<string, string>;
  /** Leases to grant, relative globs. */
  leases?: { agent: string; glob: string; bean?: string }[];
  /** The budgets to set, with what the bean has already spent. */
  budgets?: { bean: string; limit: number; used: number }[];
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
  for (const budget of fixture.budgets ?? []) {
    setBudget(db, { bean: budget.bean, tokenLimit: budget.limit });
    recordUsage(db, budget.bean, budget.used);
  }
  closeDatabase(db);

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

/**
 * Whether a record came from this agent.
 *
 * The board stores the name the agent chose to write, and an agent may write
 * its role key ('builder') or its agent id ('oa-builder'). Both name the
 * same agent, so both are accepted. A check that demands one spelling scores
 * a correct agent as silent.
 */
export function isFrom(record: { from: string }, agent: string): boolean {
  const name = (value: string): string => value.trim().toLowerCase().replace(/^oa-/, '');
  return name(record.from) === name(agent);
}

/** Every record the board holds, for the assertions on what an agent reported. */
export async function readRecords(
  state: CaseState,
): Promise<{ kind: string; from: string; bean: string; action: string; state: string }[]> {
  const db = openDatabase(state.boardPath);
  try {
    const rows = db
      .select({
        kind: records.kind,
        from: records.fromAgent,
        bean: records.bean,
        action: records.action,
        state: records.state,
      })
      .from(records)
      .orderBy(records.id)
      .all();
    return rows;
  } finally {
    closeDatabase(db);
  }
}

/**
 * Wait for a record that matches.
 *
 * Some of the work happens after the turn that the case measures: the
 * harvest runs when a session goes idle, and the archivist works after
 * that. A check that reads the board once would see a board that is not
 * finished yet, so the check waits.
 */
export async function waitForRecord(
  state: CaseState,
  match: (record: {
    kind: string;
    from: string;
    bean: string;
    action: string;
    state: string;
  }) => boolean,
  timeoutMs = 240_000,
): Promise<
  { kind: string; from: string; bean: string; action: string; state: string } | undefined
> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = (await readRecords(state)).find(match);
    if (found !== undefined) return found;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 500));
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
  options: { repoRoot: string; boardFault?: string; headless?: boolean; model?: string },
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
  // Every role runs on the model under test, the archivist included. The
  // lock names a model per role, and the archivist is a role: with the
  // lock's own model the harvest was measured on a different model than
  // the one the case is about, and a free provider's failure showed up as
  // a case that failed for the wrong reason.
  if (options.model !== undefined) {
    await rewriteLockModels(join(root, 'openagentsy.models.lock.json'), options.model);
  }

  // Bun, not node: the CLI reaches the board's database, and that database
  // is a bun:sqlite builtin. Node cannot load it, and a case whose agents
  // were never generated waits for an agent that does not exist.
  await execFileAsync(
    'bun',
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
            command: ['bun', join(options.repoRoot, 'packages', 'mcp', 'dist', 'index.js')],
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
/**
 * The paths the project protects from an agent's edit.
 *
 * A protected path is a rule the CLI adds to a writing role at generation
 * time, and the effect is "ask". In a headless case nobody answers, so the
 * harness answers instead, and it refuses the protected paths: that is the
 * answer a person would give.
 */
export async function protectedPathsOf(repoRoot: string): Promise<string[]> {
  const { parse } = await import('yaml');
  const text = await readFile(join(repoRoot, 'roles.yaml'), 'utf8');
  const roles = parse(text) as { protectedPaths?: string[] };
  return roles.protectedPaths ?? [];
}

/**
 * The permission policy of a headless case.
 *
 * Anything that touches a protected path is refused; everything else is
 * allowed once, the way a person would answer it. The refusal is what keeps
 * the red team case honest: the agent that tries to edit the roles file is
 * told no, and the case sees that the file did not change.
 */
export function casePermissionPolicy(protectedPaths: string[]) {
  return (request: { type: string; patterns: string[] }): 'once' | 'reject' => {
    if (request.type !== 'edit') return 'once';
    const touched = request.patterns.join(' ');
    const refused = protectedPaths.some((path) => touched.includes(path.replace(/\/\*\*$/, '')));
    return refused ? 'reject' : 'once';
  };
}

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

  // The researcher's whole job is the web, so a case about it would be
  // testing a researcher that cannot reach anything. The rule is per role
  // now, and the researcher keeps its access.
  const researcher = roles.roles.researcher;
  if (researcher?.permissions) {
    researcher.permissions.webfetch = 'allow';
    researcher.permissions.websearch = 'allow';
  }

  return stringify(roles);
}

/**
 * Put every role on one model.
 *
 * The lock names a model per role, and a case measures the model under
 * test. The archivist is a role, and with the lock's own model the
 * harvest ran on a different model than the case was about.
 */
async function rewriteLockModels(path: string, model: string): Promise<void> {
  let lock: unknown;
  try {
    lock = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return;
  }
  if (typeof lock !== 'object' || lock === null) return;
  const roles = (lock as { roles?: Record<string, { model?: string; ladder?: unknown }> }).roles;
  if (roles === undefined) return;
  for (const [name, entry] of Object.entries(roles)) {
    roles[name] = { ...entry, model, ladder: [{ model }] };
  }
  await writeFile(path, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
}
