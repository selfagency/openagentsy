import { readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  agentIdOf,
  closeDatabase,
  type Lease,
  listLeases,
  loadRoles,
  openDatabase,
  type Target,
} from '@openagentsy/core';
import { parse as parseJsonc } from 'jsonc-parser';
import { lockEntryFor, readModelLock } from '../generate/lock.js';
import {
  detectOpenCode,
  type FoundSkill,
  findSkills,
  type OpenCodeVersion,
  PROJECT_CONFIG_NAMES,
  targetForVersion,
} from '../opencode.js';
import { findPluginBundle } from '../plugin.js';

export type ConfigReport = {
  path: string | undefined;
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

export type DoctorReport = {
  opencode: { version: OpenCodeVersion | undefined; target: Target };
  config: ConfigReport;
  plugin: PluginReport;
  roles: RoleReport[];
  skills: FoundSkill[];
  board: BoardReport;
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
  for (const name of PROJECT_CONFIG_NAMES) {
    const path = join(root, name);
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
      exists: true,
      compactionAuto: compaction.auto,
      compactionPrune: compaction.prune,
      mcpServers: listMcpServers(config),
      plugins: Array.isArray(plugins) ? plugins.map(String) : [],
    };
  }

  return {
    path: undefined,
    exists: false,
    compactionAuto: undefined,
    compactionPrune: undefined,
    mcpServers: [],
    plugins: [],
  };
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

export async function runDoctor(root: string): Promise<DoctorReport> {
  const warnings: string[] = [];
  const version = await detectOpenCode();
  const target: Target = version ? targetForVersion(version) : 'v1';

  if (!version) {
    warnings.push('opencode binary not found on PATH, assuming v1 layout');
  }

  const config = await readProjectConfig(root);

  warnings.push(...compactionWarnings(config));
  if (!config.exists) {
    warnings.push('no project config found, run: openagentsy setup');
  }
  if (!config.mcpServers.includes('openagentsy')) {
    warnings.push('the openagentsy MCP server is not registered in the project config');
  }

  const roles = await loadRoles(join(root, 'roles.yaml'));
  const lock = await readModelLock(join(root, 'openagentsy.models.lock.json'));

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

  const skills = await findSkills(root);
  const stateDir = join(root, '.openagentsy');
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
  const pluginPath = join(root, '.opencode', 'plugins', 'openagentsy.js');
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
    plugin: {
      path: pluginPath,
      installed: pluginInstalled,
      bundlePath: bundlePath ?? '',
      bundleBuilt,
    },
    roles: roleReports,
    skills,
    board: {
      root: relative(root, stateDir) || '.openagentsy',
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
    warnings,
  };
}

function field(label: string, value: string): string {
  return `  ${label.padEnd(12)}${value}`;
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
  lines.push(field('path', report.config.path ?? 'not found'));
  lines.push(
    field(
      'compaction',
      `auto=${String(report.config.compactionAuto ?? 'unset')} prune=${String(
        report.config.compactionPrune ?? 'unset',
      )}`,
    ),
  );
  lines.push(field('mcp', report.config.mcpServers.join(', ') || 'none'));
  lines.push(field('plugins', report.config.plugins.join(', ') || 'none'));

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
