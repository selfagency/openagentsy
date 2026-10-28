import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  agentIdOf,
  closeDatabase,
  type Lease,
  listLeases,
  loadRoles,
  openDatabase,
  type ProjectRoots,
  type RolesFile,
  type Target,
} from '@openagentsy/core';
import { parse as parseJsonc } from 'jsonc-parser';
import { parse as parseYaml } from 'yaml';
import { agentFileName } from '../generate/agent.js';
import { lockEntryFor, readModelLock } from '../generate/lock.js';
import {
  detectOpenCode,
  type FoundSkill,
  findConfigPaths,
  findSkills,
  type OpenCodeVersion,
} from '../opencode.js';
import { findPluginBundle } from '../plugin.js';
import { runBuild } from './build.js';

export type ConfigReport = {
  path: string | undefined;
  /** Every config file OpenCode merges, in the order it reads them. */
  paths: string[];
  exists: boolean;
  compactionAuto: unknown;
  compactionPrune: unknown;
  mcpServers: string[];
  plugins: string[];
};

export type RoleReport = {
  role: string;
  agent: string;
  model: string;
  evidence: string;
};

export type BoardReport = {
  root: string;
  databasePath: string;
  databaseExists: boolean;
  leases: number;
  auditPath: string;
  auditExists: boolean;
  auditEntries: number;
};

export type PluginReport = {
  path: string;
  installed: boolean;
  bundlePath: string;
  bundleBuilt: boolean;
};

/**
 * What a fresh render of the roles says about the installed files.
 *
 * The generated files are written by a person who runs the generator, so an
 * out-of-band edit is invisible until something compares the tree with the
 * generator. The doctor does that comparison, and it never writes into the
 * project: the render happens in a temporary directory.
 */
export type RegenerationReport = {
  /** The generated files that disagree with a fresh render. */
  drifted: string[];
  /** The command that reconciles the tree. */
  reconcile: string;
  /** Why the comparison did not run, when it did not run. */
  error?: string | undefined;
};

/** One of the five files that decide how this project is configured. */
export type ConfigAuthority = {
  /** The file, or the files the host merges. */
  path: string;
  exists: boolean;
  /** What the file is authoritative for, in one line. */
  authority: string;
  /** Who writes it. */
  writtenBy: string;
  /** True when the file is not the tool's to write. */
  protected: boolean;
};

/** The Phase 2 keys, with the defaults filled in. */
export type Phase2Config = {
  tasks: { path: string; prefix: string; idLength: number };
  memory: { maxTextChars: number; inboxLimit: number };
  footprint: {
    showWarming: boolean;
    prefill: boolean;
    gridRegion: string;
    localDeviceWatts: [number, number];
    models: string[];
  };
};

export type ConfigMap = {
  authorities: ConfigAuthority[];
  effective: Phase2Config;
  /** The places two files answer the same question. */
  overlaps: string[];
};

/** One of the first-party documents the framework ships at the project root. */
export type FirstPartyDocument = {
  /** The file name, at the root of the project. */
  file: string;
  /** What the document is for, in one line. */
  what: string;
  /** Where it was looked for. */
  path: string;
  /** Whether the project carries it. */
  exists: boolean;
  /** The version it declares, when it declares one. */
  version: string | undefined;
};

/** The first-party documents of a project, and the version they agree on. */
export type DocumentsReport = {
  documents: FirstPartyDocument[];
  /** The version every document declares, when they all declare the same one. */
  version: string | undefined;
};

export type DoctorReport = {
  opencode: { version: OpenCodeVersion | undefined; target: Target };
  config: ConfigReport;
  configMap: ConfigMap;
  plugin: PluginReport;
  roles: RoleReport[];
  skills: FoundSkill[];
  board: BoardReport;
  regeneration: RegenerationReport;
  documents: DocumentsReport;
  warnings: string[];
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function listMcpServers(config: Record<string, unknown>): string[] {
  const mcp = asRecord(config.mcp);
  const servers = asRecord(mcp.servers);
  const names = new Set([
    ...Object.keys(servers),
    ...Object.keys(mcp).filter((key) => key !== 'servers'),
  ]);
  return [...names].sort();
}

async function readProjectConfig(root: string): Promise<ConfigReport> {
  const paths = await findConfigPaths(root);
  for (const path of paths) {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    const config = asRecord(parseJsonc(text));
    const compaction = asRecord(config.compaction);
    const plugins = config.plugin ?? config.plugins;
    return {
      path,
      paths,
      exists: true,
      compactionAuto: compaction.auto,
      compactionPrune: compaction.prune,
      mcpServers: listMcpServers(config),
      plugins: Array.isArray(plugins) ? plugins.map(String) : [],
    };
  }

  return {
    path: undefined,
    paths,
    exists: false,
    compactionAuto: undefined,
    compactionPrune: undefined,
    mcpServers: [],
    plugins: [],
  };
}

/**
 * The five files that decide how this project is configured.
 *
 * The order is the order of authority: a person's roles.yaml outranks the
 * host's config, and .beans.yml outranks the Phase 2 keys, so the two tools
 * write the same task ids.
 */
const AUTHORITIES = [
  {
    file: 'roles.yaml',
    authority: 'roles, permission maps, guidance',
    writtenBy: 'a person; the generator consumes it',
    protected: true,
  },
  {
    file: 'opencode.json',
    authority: 'the host: plugins, permissions, compaction',
    writtenBy: 'a person; setup warns on an overlap',
    protected: true,
  },
  {
    file: 'openagentsy.jsonc',
    authority: 'the Phase 2 keys',
    writtenBy: 'a person',
    protected: true,
  },
  {
    file: '.beans.yml',
    authority: 'beans interop: prefix, id length, path',
    writtenBy: 'a person',
    protected: false,
  },
  {
    file: 'openagentsy.models.lock.json',
    authority: 'the model lock',
    writtenBy: 'openagentsy models init',
    protected: true,
  },
];

/**
 * The first-party documents, and what each one is for.
 *
 * They live at the root of the project because they are the project's own:
 * the stance, the controls and the process the framework is held to. The
 * doctor reports whether the project carries them and which version they are
 * at, so a project that has adopted them can show that it has.
 */
const FIRST_PARTY_DOCUMENTS = [
  { file: 'ETHICS.md', what: 'the ethical stance' },
  { file: 'SAFETY.md', what: 'the safety controls' },
  { file: 'GOVERNANCE.md', what: 'the governance process' },
  { file: 'CHANGELOG-SAFETY.md', what: 'the safety changelog' },
] as const;

/** The Phase 2 keys, as they are when nobody says otherwise. */
const PHASE2_DEFAULTS = {
  tasks: { path: '.beans', prefix: 'oa-', idLength: 4 },
  memory: { maxTextChars: 280, inboxLimit: 50 },
  footprint: {
    showWarming: true,
    prefill: false,
    gridRegion: 'auto',
    localDeviceWatts: [25, 60] as [number, number],
  },
};

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function numberOr(value: unknown, fallback: number): number {
  const found = firstNumber(value);
  return found ?? fallback;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function rangeOr(value: unknown, fallback: [number, number]): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) return fallback;
  const lo = value[0];
  const hi = value[1];
  if (typeof lo !== 'number' || typeof hi !== 'number') return fallback;
  return [lo, hi];
}

async function fileExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** A JSONC file, read the way a person writes one: with comments. */
async function readJsoncFile(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const text = await readFile(path, 'utf8');
    return asRecord(parseJsonc(text));
  } catch {
    return undefined;
  }
}

async function readYamlFile(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const text = await readFile(path, 'utf8');
    return asRecord(parseYaml(text));
  } catch {
    return undefined;
  }
}

/**
 * The Phase 2 keys, with the defaults filled in.
 *
 * .beans.yml decides the task ids, so it outranks the tasks.* keys of
 * openagentsy.jsonc. The two tools then write the same ids.
 */
function effectiveConfig(
  agentsy: Record<string, unknown>,
  beans: Record<string, unknown>,
): Phase2Config {
  const tasks = asRecord(agentsy.tasks);
  const beansKeys = asRecord(beans.beans);
  const memory = asRecord(agentsy.memory);
  const footprint = asRecord(agentsy.footprint);

  return {
    tasks: {
      path: stringOr(beansKeys.path, stringOr(tasks.path, PHASE2_DEFAULTS.tasks.path)),
      prefix: stringOr(beansKeys.prefix, stringOr(tasks.prefix, PHASE2_DEFAULTS.tasks.prefix)),
      idLength:
        firstNumber(beansKeys.id_length, beansKeys.idLength, tasks.idLength) ??
        PHASE2_DEFAULTS.tasks.idLength,
    },
    memory: {
      maxTextChars: numberOr(memory.maxTextChars, PHASE2_DEFAULTS.memory.maxTextChars),
      inboxLimit: numberOr(memory.inboxLimit, PHASE2_DEFAULTS.memory.inboxLimit),
    },
    footprint: {
      showWarming: booleanOr(footprint.showWarming, PHASE2_DEFAULTS.footprint.showWarming),
      prefill: booleanOr(footprint.prefill, PHASE2_DEFAULTS.footprint.prefill),
      gridRegion: stringOr(footprint.gridRegion, PHASE2_DEFAULTS.footprint.gridRegion),
      localDeviceWatts: rangeOr(
        footprint.localDeviceWatts,
        PHASE2_DEFAULTS.footprint.localDeviceWatts,
      ),
      models: Object.keys(asRecord(footprint.models)).sort(),
    },
  };
}

/** The places where two files answer the same question. */
function configOverlaps(
  authorities: ConfigAuthority[],
  hasAgentsy: boolean,
  hasBeans: boolean,
  opencodePaths: string[],
): string[] {
  const overlaps: string[] = [];
  const rolesExist = authorities.some(
    (authority) => authority.path === 'roles.yaml' && authority.exists,
  );

  if (opencodePaths.length > 1) {
    overlaps.push(
      `OpenCode merges ${opencodePaths.length} config files: ${opencodePaths.join(', ')}.`,
    );
  }
  if (rolesExist && opencodePaths.length > 0) {
    overlaps.push(
      'roles.yaml and the OpenCode config both carry permissions; the roles in roles.yaml are the ones this project generates.',
    );
  }
  if (hasAgentsy && hasBeans) {
    overlaps.push('openagentsy.jsonc and .beans.yml both decide the task ids; .beans.yml wins.');
  }
  return overlaps;
}

/**
 * The map of the five authorities, and the Phase 2 keys in force.
 *
 * A file that is not there is still part of the system, because a person
 * may write it later, so the map says so.
 */
async function readConfigMap(root: string, opencodePaths: string[]): Promise<ConfigMap> {
  const agentsy = await readJsoncFile(join(root, 'openagentsy.jsonc'));
  const beans = await readYamlFile(join(root, '.beans.yml'));

  const authorities: ConfigAuthority[] = [];
  for (const entry of AUTHORITIES) {
    const isHost = entry.file === 'opencode.json';
    authorities.push({
      path: isHost && opencodePaths.length > 0 ? opencodePaths.join(', ') : entry.file,
      exists: isHost ? opencodePaths.length > 0 : await fileExists(join(root, entry.file)),
      authority: entry.authority,
      writtenBy: entry.writtenBy,
      protected: entry.protected,
    });
  }

  return {
    authorities,
    effective: effectiveConfig(agentsy ?? {}, beans ?? {}),
    overlaps: configOverlaps(
      authorities,
      agentsy !== undefined,
      beans !== undefined,
      opencodePaths,
    ),
  };
}

/**
 * The version a document declares.
 *
 * The marker is the same in all four documents, so the doctor reads one
 * line and does not have to know what each document is.
 */
function documentVersion(content: string): string | undefined {
  const match = /^\*\*Version:\*\*\s+(\S+)\s*$/m.exec(content);
  return match?.[1];
}

/**
 * The first-party documents of a project.
 *
 * A document that is not there is reported as missing, and a document that
 * cannot be read is reported as missing too: the doctor describes what it
 * can see, and never presents a file it could not read as present.
 */
async function readDocuments(root: string): Promise<DocumentsReport> {
  const documents: FirstPartyDocument[] = [];
  for (const entry of FIRST_PARTY_DOCUMENTS) {
    const path = join(root, entry.file);
    const content = await readFile(path, 'utf8').catch(() => undefined);
    documents.push({
      file: entry.file,
      what: entry.what,
      path,
      exists: content !== undefined,
      version: content === undefined ? undefined : documentVersion(content),
    });
  }
  return { documents, version: sharedVersion(documents) };
}

/**
 * The version the documents agree on, when they all declare the same one.
 *
 * A document without a version breaks the agreement: one file that does not
 * say which version it is at means the project cannot be said to be at a
 * version at all.
 */
function sharedVersion(documents: FirstPartyDocument[]): string | undefined {
  const present = documents.filter((document) => document.exists);
  if (present.length === 0) return undefined;
  const declared = present.map((document) => document.version);
  if (declared.some((version) => version === undefined)) return undefined;
  const unique = new Set(declared);
  return unique.size === 1 ? [...unique][0] : undefined;
}

/**
 * What is wrong with the first-party documents of a project.
 *
 * A project that carries none of them has not adopted the framework's
 * documents, which is a fact about the project and not a fault in it. A
 * project that carries some of them and is missing another has an incomplete
 * set, and that is a finding.
 */
function documentWarnings(report: DocumentsReport): string[] {
  const warnings: string[] = [];
  const present = report.documents.filter((document) => document.exists);
  if (present.length === 0) return warnings;

  for (const document of report.documents) {
    if (!document.exists) {
      warnings.push(
        `${document.file} is missing, and the project carries the other first-party documents`,
      );
    } else if (document.version === undefined) {
      warnings.push(
        `${document.file} has no version line, so the doctor cannot say which version it is at`,
      );
    }
  }

  const versions = new Set(
    present.map((document) => document.version).filter((version) => version !== undefined),
  );
  if (versions.size > 1) {
    const detail = present
      .map((document) => `${document.file} ${document.version ?? 'none'}`)
      .join(', ');
    warnings.push(`the first-party documents are at different versions: ${detail}`);
  }
  return warnings;
}

async function countAuditLines(path: string): Promise<number> {
  try {
    const text = await readFile(path, 'utf8');
    return text.split('\n').filter((line) => line.trim().length > 0).length;
  } catch {
    return 0;
  }
}

/**
 * What the compaction settings say.
 *
 * Compaction off is right for a memory integration that shrinks the context
 * itself, and there is no such integration yet, so a long Lead session grows
 * without a bound.
 */
function compactionWarnings(config: ConfigReport): string[] {
  const warnings: string[] = [];
  if (config.compactionAuto === true) {
    warnings.push('compaction.auto is true. Magic Context requires compaction to be off.');
  }
  if (config.compactionPrune === true) {
    warnings.push('compaction.prune is true, it removes tool output the Lead still needs.');
  }
  if (config.compactionAuto === false) {
    warnings.push(
      'compaction is off and no memory integration is installed, so a long Lead session grows without a bound. Run: openagentsy setup (without --magic-context), or accept the tradeoff.',
    );
  }
  return warnings;
}

/**
 * The leases that may belong to a session that is gone.
 *
 * A lease is only ever released by the agent that holds it, so a session
 * that died holding one holds its files until the Lead revokes it. A lease
 * that is a week old is worth saying out loud.
 */
function staleLeaseWarnings(held: Lease[]): string[] {
  const week = 7 * 24 * 60 * 60 * 1000;
  const warnings: string[] = [];
  for (const lease of held) {
    const age = Date.now() - new Date(lease.grantedAt).getTime();
    if (age <= week) continue;
    const days = Math.floor(age / (24 * 60 * 60 * 1000));
    warnings.push(
      `a lease on ${lease.glob} was taken ${days} days ago and may be a dead session's. The Lead can take it back with board_lease_revoke.`,
    );
  }
  return warnings;
}

/** The command that reconciles the generated agent files. */
const RECONCILE_BUILD = 'openagentsy build';

/**
 * The agent files of a directory, by name.
 *
 * A directory that cannot be read is a failure and not an empty tree: an
 * empty tree would say every generated file is missing.
 */
async function agentFiles(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.md')) continue;
    files.set(name, await readFile(join(dir, name), 'utf8'));
  }
  return files;
}

/** The target one agent file was built for, when its frontmatter says. */
function targetOfAgentFile(content: string): Target | undefined {
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  if (match === null) return undefined;
  const frontmatter = asRecord(parseYaml(match[1] ?? ''));
  if (frontmatter.permissions !== undefined) return 'v2';
  return undefined;
}

/**
 * The targets the installed files say they were built for.
 *
 * The doctor cannot recover the target a project was built for from the
 * OpenCode it finds on PATH: a project built for v2 on a machine with v1
 * installed is not a drifted tree, it is a v2 tree, and rendering it for the
 * wrong target would flag every file. The installed files say which target
 * they are, so the files are what the check asks.
 */
function installedTargets(files: Map<string, string>): Set<Target> {
  const targets = new Set<Target>();
  for (const content of files.values()) {
    const target = targetOfAgentFile(content);
    if (target !== undefined) targets.add(target);
  }
  return targets;
}

/** The target the installed files agree on, or why there is none. */
type TargetVerdict = {
  target: Target | undefined;
  error?: string | undefined;
};

/**
 * The target the installed files name, and the reason when they do not.
 *
 * A tree whose target cannot be read is a tree the check cannot judge: the
 * skip is reported, never presented as a clean tree.
 */
function judgeTarget(files: Map<string, string>): TargetVerdict {
  const targets = installedTargets(files);
  if (targets.size === 1) {
    const [target] = targets;
    return { target };
  }
  return {
    target: undefined,
    error: 'no installed agent file says which target it was built for',
  };
}

/** What the regeneration check found, and the target it judged. */
type RegenerationDiff = {
  drifted: string[];
  target: Target | undefined;
  /** Why the check did not run, when it did not run. */
  error?: string | undefined;
};

/**
 * The generated files that disagree with a fresh render of the roles.
 *
 * The render happens in a temporary directory: the doctor never writes into
 * the project it is describing, because the person who runs it may be about
 * to change that project.
 */
async function regenerationDiff(roots: ProjectRoots, ours: Set<string>): Promise<RegenerationDiff> {
  const installedDir = join(roots.workspace, '.opencode', 'agents');
  // A tree that was never built has nothing to drift from, and the setup
  // warning already says the plugin is not installed.
  if (!(await fileExists(installedDir))) return { drifted: [], target: undefined };

  const installed = await agentFiles(installedDir);
  // A tree with no agent files has nothing to drift from.
  if (installed.size === 0) return { drifted: [], target: undefined };

  // The check cannot judge a tree whose target cannot be read: rendering it
  // for the wrong target would flag every file, and saying nothing would say
  // the tree is clean. A skip is reported as a failure.
  const verdict = judgeTarget(installed);
  if (verdict.target === undefined) {
    return { drifted: [], target: undefined, error: verdict.error };
  }
  const target = verdict.target;

  const temp = await mkdtemp(join(tmpdir(), 'openagentsy-regeneration-'));
  try {
    await runBuild({ workspace: roots.workspace, stateRoot: roots.stateRoot, outDir: temp });
    const fresh = await agentFiles(join(temp, 'agents'));

    const drifted: string[] = [];
    for (const [name, content] of fresh) {
      const current = installed.get(name);
      if (current === undefined) drifted.push(`${name} is missing`);
      else if (current !== content) drifted.push(`${name} differs from a fresh render`);
    }
    for (const name of installed.keys()) {
      if (fresh.has(name)) continue;
      // A file the generator does not write is only a drift when it is one
      // of ours: a person may keep their own agent file beside ours.
      if (!ours.has(name) && !name.startsWith('oa-')) continue;
      drifted.push(`${name} is stale: the generator does not write it any more`);
    }
    return { drifted, target };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

/**
 * The comparison, and what a failure of it costs.
 *
 * A doctor that cannot run the comparison says so rather than pretending
 * the tree is clean.
 */
async function regenerationReport(
  roots: ProjectRoots,
  roles: RolesFile,
): Promise<RegenerationReport> {
  const ours = new Set(Object.values(roles.roles).map((role) => agentFileName(role)));
  try {
    const diff = await regenerationDiff(roots, ours);
    return {
      drifted: diff.drifted,
      reconcile:
        diff.target === undefined ? RECONCILE_BUILD : `${RECONCILE_BUILD} --target ${diff.target}`,
      ...(diff.error === undefined ? {} : { error: diff.error }),
    };
  } catch (error) {
    return {
      drifted: [],
      reconcile: RECONCILE_BUILD,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * The doctor, as a person reads it.
 *
 * The report has two halves and they have two roots. The project half — the
 * config, the roles, the skills and the installed plugin — is the
 * workspace's, because those are the files of the project. The state half —
 * the model lock, the board and the audit log — is the state root's, because
 * those are the files of the project as a whole.
 */
export async function runDoctor(roots: ProjectRoots): Promise<DoctorReport> {
  const { workspace, stateRoot } = roots;
  const warnings: string[] = [];
  const version = await detectOpenCode();
  const target: Target = 'v2';

  if (!version) {
    warnings.push('opencode binary not found on PATH, assuming v2 layout');
  }

  const config = await readProjectConfig(workspace);
  const configMap = await readConfigMap(workspace, config.paths);
  const documents = await readDocuments(workspace);

  warnings.push(...compactionWarnings(config));
  warnings.push(...documentWarnings(documents));
  if (!config.exists) {
    warnings.push('no project config found, run: openagentsy setup');
  }
  if (!config.mcpServers.includes('openagentsy')) {
    warnings.push('the openagentsy MCP server is not registered in the project config');
  }

  const roles = await loadRoles(join(workspace, 'roles.yaml'));
  // The model lock is the state root's: it is the choice of models the
  // project made, and a worktree of the project has the same lock.
  const lock = await readModelLock(join(stateRoot, 'openagentsy.models.lock.json'));

  const regeneration = await regenerationReport(roots, roles);
  for (const entry of regeneration.drifted) {
    warnings.push(`the generated agent file ${entry}, run: ${regeneration.reconcile} to reconcile`);
  }
  if (regeneration.error !== undefined) {
    warnings.push(`the regeneration check did not run: ${regeneration.error}`);
  }

  const roleReports: RoleReport[] = Object.values(roles.roles).map((role) => {
    const entry = lockEntryFor(lock, role.name);
    return {
      role: role.name,
      agent: agentIdOf(role),
      model: entry?.model ?? 'default (no lock file)',
      evidence: entry?.evidence
        ? `${entry.evidence.source}${entry.evidence.label ? ` [${entry.evidence.label}]` : ''}`
        : 'none',
    };
  });

  if (!lock) {
    warnings.push('no model lock file, run: openagentsy models init');
  }

  const skills = await findSkills(workspace);
  // The board and the audit log are the state root's.
  const stateDir = join(stateRoot, '.openagentsy');
  const databasePath = join(stateDir, 'board.sqlite');
  const auditPath = join(stateDir, 'audit.jsonl');

  const databaseExists = await stat(databasePath).then(
    () => true,
    () => false,
  );

  // The leases live in the database now; the doctor counts them the way the
  // board does, without opening a second connection for long.
  let leaseCount = 0;
  if (databaseExists) {
    const db = openDatabase(databasePath);
    try {
      const held = listLeases(db);
      leaseCount = held.length;
      warnings.push(...staleLeaseWarnings(held));
    } finally {
      closeDatabase(db);
    }
  }

  const bundlePath = await findPluginBundle();
  const pluginPath = join(workspace, '.opencode', 'plugins', 'openagentsy.js');
  const pluginInstalled = await stat(pluginPath).then(
    () => true,
    () => false,
  );
  const bundleBuilt = bundlePath !== undefined;

  if (!pluginInstalled) {
    warnings.push('the OpenAgentsy plugin is not installed, run: openagentsy setup');
  }

  return {
    opencode: { version, target },
    config,
    configMap,
    plugin: {
      path: pluginPath,
      installed: pluginInstalled,
      bundlePath: bundlePath ?? '',
      bundleBuilt,
    },
    roles: roleReports,
    skills,
    board: {
      root: relative(stateRoot, stateDir) || '.openagentsy',
      databasePath,
      databaseExists,
      leases: leaseCount,
      auditPath,
      auditExists: await stat(auditPath).then(
        () => true,
        () => false,
      ),
      auditEntries: await countAuditLines(auditPath),
    },
    regeneration,
    documents,
    warnings,
  };
}

function field(label: string, value: string): string {
  return `  ${label.padEnd(12)}${value}`;
}

/**
 * The lines about the project config.
 *
 * OpenCode merges every config it finds, so the ones the doctor did not
 * read are part of the system too.
 */
function configLines(config: ConfigReport): string[] {
  const lines = [field('path', config.path ?? 'not found')];
  if (config.paths.length > 1) {
    lines.push(field('merged', config.paths.join(', ')));
  }
  lines.push(
    field(
      'compaction',
      `auto=${String(config.compactionAuto ?? 'unset')} prune=${String(
        config.compactionPrune ?? 'unset',
      )}`,
    ),
  );
  lines.push(field('mcp', config.mcpServers.join(', ') || 'none'));
  lines.push(field('plugins', config.plugins.join(', ') || 'none'));
  return lines;
}

/**
 * The lines about the config map.
 *
 * A file that is not there is still part of the system, so the map says
 * "missing" instead of leaving the reader to guess.
 */
function configMapLines(map: ConfigMap): string[] {
  const lines: string[] = [];
  for (const authority of map.authorities) {
    lines.push(`  ${authority.path}`);
    lines.push(
      `    ${authority.exists ? 'found' : 'missing'} - ${authority.authority} (written by ${authority.writtenBy}${authority.protected ? ', protected' : ''})`,
    );
  }
  return lines;
}

/** The lines about the Phase 2 keys in force. */
function phase2Lines(effective: Phase2Config): string[] {
  const key = (label: string, value: string): string => `  ${label.padEnd(24)}${value}`;
  const watts = effective.footprint.localDeviceWatts;
  return [
    key('tasks.path', effective.tasks.path),
    key('tasks.prefix', effective.tasks.prefix),
    key('tasks.idLength', String(effective.tasks.idLength)),
    key('memory.maxTextChars', String(effective.memory.maxTextChars)),
    key('memory.inboxLimit', String(effective.memory.inboxLimit)),
    key('footprint.showWarming', String(effective.footprint.showWarming)),
    key('footprint.prefill', String(effective.footprint.prefill)),
    key('footprint.gridRegion', effective.footprint.gridRegion),
    key('footprint.localDeviceWatts', `${watts[0]}-${watts[1]} W`),
    key('footprint.models', effective.footprint.models.join(', ') || 'none'),
  ];
}

/**
 * The lines about the first-party documents.
 *
 * A document that is not there says so, because a reader who is told a
 * document is present must be able to rely on it.
 */
function documentLines(report: DocumentsReport): string[] {
  const lines = ['First-party documents'];
  for (const document of report.documents) {
    const state = !document.exists
      ? 'missing'
      : document.version === undefined
        ? 'found, no version'
        : `found, version ${document.version}`;
    lines.push(`  ${document.file.padEnd(20)}${state} - ${document.what}`);
  }
  if (report.documents.every((document) => !document.exists)) {
    lines.push('  none of the first-party documents are in this project');
  }
  return lines;
}

/**
 * The lines about the generated files that disagree with a fresh render.
 *
 * A tree the generator wrote has nothing to say here, so the section is
 * only there when something drifted or the check could not run.
 */
function regenerationLines(report: RegenerationReport): string[] {
  const lines = ['Regeneration'];
  lines.push(field('drifted', `${report.drifted.length} file(s), run: ${report.reconcile}`));
  for (const entry of report.drifted) {
    lines.push(`  - ${entry}`);
  }
  if (report.error !== undefined) {
    lines.push(field('error', report.error));
  }
  return lines;
}

/** Whether the report has something to say about the generated files. */
function hasRegenerationFinding(report: RegenerationReport): boolean {
  return report.drifted.length > 0 || report.error !== undefined;
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];

  lines.push('OpenCode');
  if (report.opencode.version) {
    lines.push(field('version', report.opencode.version.raw));
    lines.push(field('target', report.opencode.target));
  } else {
    lines.push(field('version', 'not found'));
  }

  lines.push('');
  lines.push('Project config');
  lines.push(...configLines(report.config));

  lines.push('');
  lines.push('Config map');
  lines.push(...configMapLines(report.configMap));

  lines.push('');
  lines.push('Phase 2 keys');
  lines.push(...phase2Lines(report.configMap.effective));

  if (report.configMap.overlaps.length > 0) {
    lines.push('');
    lines.push('Overlaps');
    for (const overlap of report.configMap.overlaps) {
      lines.push(`  - ${overlap}`);
    }
  }

  lines.push('');
  lines.push(...documentLines(report.documents));

  if (hasRegenerationFinding(report.regeneration)) {
    lines.push('');
    lines.push(...regenerationLines(report.regeneration));
  }

  if (report.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings');
    for (const warning of report.warnings) {
      lines.push(`  - ${warning}`);
    }
  }

  lines.push('');
  lines.push('Plugin');
  lines.push(field('installed', report.plugin.installed ? report.plugin.path : 'not installed'));
  if (!report.plugin.bundleBuilt) {
    lines.push(field('bundle', 'not built, run: bun run build'));
  }

  lines.push('');
  lines.push('Roles');
  for (const role of report.roles) {
    lines.push(`  ${role.agent.padEnd(14)}${role.model}   (${role.evidence})`);
  }

  lines.push('');
  lines.push('Board');
  lines.push(
    field(
      'database',
      `${report.board.databasePath} ${report.board.databaseExists ? 'found' : 'missing'}`,
    ),
  );
  lines.push(field('leases', `${report.board.leases} lease(s)`));
  lines.push(field('audit', `${report.board.auditPath} ${report.board.auditEntries} entries`));

  lines.push('');
  lines.push(`Skills (${report.skills.length} found)`);
  for (const skill of report.skills) {
    lines.push(`  ${skill.name.padEnd(28)}${skill.path}`);
  }

  return `${lines.join('\n')}\n`;
}
