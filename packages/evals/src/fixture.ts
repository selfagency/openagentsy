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
import { closeLedger, openLedger, recordAssistantMessage } from '@openagentsy/ledger';
import { type ParseError, parse as parseJsonc } from 'jsonc-parser';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { gitFreeEnv } from './git-env.js';
import type { OpenCodeRuntime } from './opencode.js';

const execFileAsync = promisify(execFile);

export type Fixture = {
  /** Files to write, keyed by path relative to the case directory. */
  files: Record<string, string>;
  /** Leases to grant, relative globs. */
  leases?: { agent: string; glob: string; bean?: string }[];
  /** The budgets to set, with what the bean has already spent. */
  budgets?: { bean: string; limit: number; used: number }[];
  /**
   * The usage the ledger holds before the case runs.
   *
   * The cap is in the board and the usage is in the ledger (§6.7), so a case
   * that needs a bean to look over its budget writes the tokens the ledger
   * counted. The bean id is the ledger's task id: that is the join the
   * board's check makes.
   */
  ledgerUsage?: { bean: string; tokens: number; turns?: number }[];
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

  // The git commands get an environment without the git variables, so a
  // suite that runs inside a hook still seeds the case's own repository and
  // not the one the hook belongs to.
  await execFileAsync('git', ['init', '-q'], { cwd: root, env: gitFreeEnv() });
  await execFileAsync('git', ['add', '-A'], { cwd: root, env: gitFreeEnv() });
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
    { cwd: root, env: gitFreeEnv() },
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

  await seedLedger(root, fixture.ledgerUsage ?? []);

  return {
    root,
    leases,
    auditPath: join(stateDir, 'audit.jsonl'),
    boardPath: join(stateDir, 'board.sqlite'),
  };
}

/**
 * Write the usage the ledger holds before the case runs.
 *
 * The ledger is the measurement: the board's check reads the bean's usage
 * from it, so a case that seeds usage has to seed the ledger and not the
 * board's self-report. The rows carry the bean's id as the task id.
 */
async function seedLedger(
  root: string,
  usage: { bean: string; tokens: number; turns?: number }[],
): Promise<void> {
  if (usage.length === 0) return;
  const ledger = openLedger(root);
  try {
    for (const entry of usage) {
      const turns = Math.max(1, entry.turns ?? 1);
      const each = Math.floor(entry.tokens / turns);
      let left = entry.tokens;
      for (let turn = 0; turn < turns && left > 0; turn += 1) {
        const tokens = turn === turns - 1 ? left : each;
        left -= tokens;
        recordAssistantMessage(
          ledger,
          {
            id: `seed-${entry.bean}-${turn}`,
            sessionID: `seed-session-${entry.bean}`,
            providerID: 'seed',
            modelID: 'seed-model',
            tokens: { input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
          {
            rootSessionId: `seed-session-${entry.bean}`,
            role: 'builder',
            activeTaskId: entry.bean,
            ts: new Date().toISOString(),
          },
        );
      }
    }
  } finally {
    closeLedger(ledger);
  }
}

/** The files a case may write, so the assertions can tell what changed. */
export async function readAudit(state: CaseState): Promise<
  {
    policyId: string;
    actor: string;
    action: string;
    resource: string;
    effect: string;
    /** Why the decision was taken. A refusal says what was wrong. */
    detail?: string;
  }[]
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
 *
 * A dispatch label names the same agent too: the Lead dispatches 'builder-2'
 * and grants the lease to that name, but the session that runs is the
 * builder role, and it posts under the label it was given (measured
 * 2026-10-27: the builder's completion record was invisible to the
 * confirmation and the case failed with 'a completion nobody confirmed').
 */
export function isFrom(record: { from: string }, agent: string): boolean {
  const name = (value: string): string =>
    value.trim().toLowerCase().replace(/^oa-/, '').replace(/-\d+$/, '');
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
 * The judge agent, in the shape the runtime reads.
 *
 * The judge is not a role, so the CLI does not write it: the suite copies the
 * template into the case directory. The template is an OpenCode 1 file, and
 * the 2.x server reads a different frontmatter: the permission map becomes
 * an ordered list of rules and the tools carry the 2.x names. A file the 2.x
 * server cannot read is an agent that does not exist, and the judge then
 * answers without its instructions: measured on 2026-10-27, the judge of the
 * budget stop case answered in prose and the case failed on the answer.
 */
async function judgeAgent(repoRoot: string, runtime: OpenCodeRuntime): Promise<string> {
  const template = await readFile(
    join(repoRoot, 'packages', 'evals', 'templates', 'judge.md'),
    'utf8',
  );
  if (runtime.major < 2) return template;
  return v2JudgeAgent(template);
}

/** The tools of the 2.x server under the names the 1.x server used. */
const V2_TOOL_NAMES: Record<string, string> = { bash: 'shell', task: 'subagent' };

/** The tools the 2.x server has no action for. */
const V2_DROPPED_TOOLS = new Set(['lsp', 'list']);

/**
 * The judge file of the 2.x server.
 *
 * The permission map of the template becomes a list of rules, the tools are
 * renamed, and the model is left out: the model of the judge's session is
 * the one the harness set, and a model in the file would argue with it.
 */
function v2JudgeAgent(template: string): string {
  const parts = splitAgentFile(template);
  if (parts === undefined) return template;
  const permission = (parts.frontmatter['permission'] ?? {}) as Record<string, string>;
  const rules = Object.entries(permission)
    .filter(([tool]) => !V2_DROPPED_TOOLS.has(tool))
    .map(([tool, effect]) => ({
      action: V2_TOOL_NAMES[tool] ?? tool,
      resource: '*',
      effect,
    }));
  const frontmatter = {
    description: parts.frontmatter['description'],
    mode: parts.frontmatter['mode'],
    steps: parts.frontmatter['steps'],
    permissions: rules,
  };
  return `---\n${stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd()}\n---\n\n${parts.body}`;
}

/** The frontmatter of an agent file, and the body under it. */
function splitAgentFile(
  text: string,
): { frontmatter: Record<string, unknown>; body: string } | undefined {
  if (!text.startsWith('---\n')) return undefined;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return undefined;
  const parsed = parseYaml(text.slice(4, end)) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  return {
    frontmatter: parsed as Record<string, unknown>,
    body: text.slice(end + 4).replace(/^\n+/, ''),
  };
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
  options: {
    repoRoot: string;
    boardFault?: string;
    headless?: boolean;
    model?: string;
    /** Whether the memory pipeline runs in this case. */
    harvest?: boolean;
    /**
     * The runtime the harness started.
     *
     * The MCP servers the machine already runs are switched off in the
     * shape that runtime reads, and the runtime is what says which shape
     * that is.
     */
    runtime: OpenCodeRuntime;
  },
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
      // The agents are built for the runtime that will read them: the two
      // runtimes read different permission keys.
      '--target',
      options.runtime.major >= 2 ? 'v2' : 'v1',
    ],
    { cwd: root },
  );

  await mkdir(join(root, '.opencode', 'plugins'), { recursive: true });
  await copyFile(
    join(options.repoRoot, 'packages', 'adapter-opencode', 'dist', 'index.js'),
    join(root, '.opencode', 'plugins', 'openagentsy.js'),
  );

  // The memory pipeline is a real agent run per finished session, and it is
  // two fifths of the provider calls a suite run makes. Only the case that
  // measures it needs it, so the rest turn it off: the pipeline runs after
  // the turn the case measures, so it cannot change what the agent under
  // test does.
  if (options.harvest !== true) {
    await mkdir(join(root, '.openagentsy'), { recursive: true });
    await writeFile(join(root, '.openagentsy', 'harvest'), 'off\n', 'utf8');
  }
  // The judge agent, which has no tools and answers with one JSON object.
  await mkdir(join(root, '.opencode', 'agents'), { recursive: true });
  await writeFile(
    join(root, '.opencode', 'agents', 'judge.md'),
    await judgeAgent(options.repoRoot, options.runtime),
    'utf8',
  );

  // The MCP servers the machine already runs are switched off for the case,
  // and the shape of that switch follows the runtime the harness started.
  const mcp = caseMcp(options.runtime);
  for (const note of mcp.notes) {
    // The harness's own behaviour about a file it skipped is said out
    // loud: a global config it could not read is not the same as a global
    // config that says nothing, and a case that runs with the machine's
    // servers on is not the case the suite meant to run.
    process.stderr.write(`[global config] ${note}\n`);
  }

  await writeFile(
    join(root, 'opencode.json'),
    `${JSON.stringify(
      {
        mcp: {
          ...mcp.mcp,
          openagentsy: {
            type: 'local',
            command: ['bun', join(options.repoRoot, 'packages', 'mcp', 'dist', 'index.js')],
            environment: {
              OPENAGENTSY_ROOT: root,
              ...(options.boardFault !== undefined
                ? { OPENAGENTSY_FAULT: options.boardFault }
                : {}),
            },
            ...(options.runtime.major >= 2 ? { disabled: false } : { enabled: true }),
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
 * The MCP servers one global config file declares, and what was wrong with it.
 */
export type GlobalMcp = {
  /** The entries the server can read, keyed by name. */
  servers: Record<string, Record<string, unknown>>;
  /**
   * The lines a person reads: what was dropped, and why.
   *
   * A file the harness could not read is said out loud. A parse failure
   * that became "no MCP servers" would hide the reason a case failed.
   */
  notes: string[];
};

/**
 * The MCP servers one global config file declares.
 *
 * The config is JSON with comments, so it is read as JSONC. The entry keeps
 * its type and its command or url, because the server rejects an entry it
 * cannot read, and it loses its environment, because a server that is
 * switched off needs no key and a case directory is a place a key should
 * not be written.
 *
 * Both shapes of the config are read: OpenCode 1 keeps the servers in a
 * flat map and OpenCode 2 nests them under "servers".
 *
 * An entry without a type is dropped. The server ignores such an entry
 * ("Ignoring MCP config entry without type"), and a case that runs with an
 * entry the server ignores is a case whose green says nothing about the
 * agent.
 */
export function globalMcpServers(path: string): GlobalMcp {
  const read = readGlobalConfig(path);
  if (read.note !== undefined) return { servers: {}, notes: [read.note] };

  const mcp = (read.parsed as { mcp?: unknown } | undefined)?.mcp;
  if (mcp === undefined || mcp === null || typeof mcp !== 'object') {
    return { servers: {}, notes: [] };
  }

  const servers: Record<string, Record<string, unknown>> = {};
  const notes: string[] = [];
  for (const [name, entry] of mcpEntriesOf(mcp as Record<string, unknown>)) {
    const server = serverEntryOf(entry);
    if (server.entry === undefined) {
      notes.push(
        `the global config ${path} declares the MCP entry "${name}" ${server.reason}; it was not copied into the case`,
      );
      continue;
    }
    servers[name] = server.entry;
  }
  return { servers, notes };
}

/**
 * The text of a global config file, or the reason it could not be read.
 *
 * jsonc-parser does not throw on a broken file: it collects the errors and
 * returns what it could parse. Without the errors a config with a missing
 * comma reads as a config that says nothing, and the run goes on into a
 * state where every session that starts dies.
 */
function readGlobalConfig(path: string): { parsed?: unknown; note?: string } {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    return {
      note: `the global config ${path} could not be read (${(error as Error).message}); it was skipped`,
    };
  }

  const errors: ParseError[] = [];
  const parsed = parseJsonc(text, errors, { allowTrailingComma: true }) as unknown;
  const first = errors[0];
  if (first !== undefined) {
    return {
      note: `the global config ${path} is not valid JSONC (${first.error} at offset ${first.offset}); it was skipped, so the MCP servers it declares are not switched off for the case`,
    };
  }
  return { parsed };
}

/**
 * The entries the mcp map of a global config holds.
 *
 * OpenCode 2 nests the servers under "servers"; OpenCode 1 keeps them in a
 * flat map. A flat entry that is itself named "servers" carries a type and
 * a nested map does not, so the type tells the two apart. Both are read,
 * because a config may hold the two shapes at once.
 */
function mcpEntriesOf(map: Record<string, unknown>): [string, unknown][] {
  const nested = map.servers;
  const isNestedMap =
    nested !== undefined &&
    nested !== null &&
    typeof nested === 'object' &&
    !Array.isArray(nested) &&
    (nested as Record<string, unknown>).type === undefined;

  const entries: [string, unknown][] = [];
  for (const [name, entry] of Object.entries(map)) {
    if (isNestedMap && name === 'servers') continue;
    entries.push([name, entry]);
  }
  if (isNestedMap) {
    for (const [name, entry] of Object.entries(nested as Record<string, unknown>)) {
      entries.push([name, entry]);
    }
  }
  return entries;
}

/**
 * The server an entry declares, or why the server will not read it.
 */
function serverEntryOf(entry: unknown): {
  entry?: Record<string, unknown>;
  reason?: string;
} {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return { reason: 'that is not an object' };
  }
  const { environment: _environment, ...rest } = entry as Record<string, unknown>;
  if (typeof rest.type !== 'string' || rest.type === '') {
    return { reason: 'without a type' };
  }
  return { entry: rest };
}

/**
 * The MCP section of a case's own config.
 *
 * The global servers the machine already runs are written next to the case's
 * own board server, switched off: a session sends the tool schemas of every
 * MCP server it can reach, and the global ones are large - the GitHub one
 * alone has sixty tools, and it is most of the prompt of a case.
 *
 * The shape follows the runtime. OpenCode 1 reads a flat map and switches a
 * server off with "enabled": false; OpenCode 2 nests the map under
 * "servers" and switches a server off with "disabled": true. An entry
 * without a type is never written: the server ignores such an entry, and a
 * case that runs with an entry the server ignores is a case whose green
 * says nothing about the agent.
 */
export function caseMcp(runtime: OpenCodeRuntime): {
  mcp: Record<string, unknown>;
  notes: string[];
} {
  const servers: Record<string, Record<string, unknown>> = {};
  const notes: string[] = [];
  for (const path of globalConfigPaths()) {
    const read = globalMcpServers(path);
    notes.push(...read.notes);
    for (const [name, entry] of Object.entries(read.servers)) {
      // The case brings its own board server, and it is never switched off.
      if (name === 'openagentsy') continue;
      servers[name] = entry;
    }
  }

  const switchedOff: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(servers)) {
    switchedOff[name] =
      runtime.major >= 2 ? { ...entry, disabled: true } : { ...entry, enabled: false };
  }
  return {
    mcp: runtime.major >= 2 ? { servers: switchedOff } : switchedOff,
    notes,
  };
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
 *
 * The ladder keeps its rungs. A ladder of one rung is a role that does not
 * climb, and the case about the climb would then fail for a reason that
 * has nothing to do with the plugin. The rungs lose their variant: the
 * model under test has none, and a variant that does not exist is a
 * switch to nothing.
 */
export async function rewriteLockModels(path: string, model: string): Promise<void> {
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
    const rungs = Array.isArray(entry.ladder) ? entry.ladder.length : 0;
    roles[name] = {
      ...entry,
      model,
      ladder: Array.from({ length: rungs }, () => ({ model })),
    };
  }
  await writeFile(path, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
}
