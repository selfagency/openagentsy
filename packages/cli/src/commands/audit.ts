import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectRoots } from '@openagentsy/core';
import {
  type Finding,
  runQualityAudit,
  type SloplintDegradation,
  type SloplintPath,
} from '@openagentsy/hooks/quality/audit';
import { loadWaiverLookup } from '@openagentsy/hooks/quality/waivers';
import { gitText } from '@openagentsy/ledger';
import { parse as parseJsonc } from 'jsonc-parser';

/**
 * The audit command.
 *
 * `openagentsy audit` reports the quality findings of the change under
 * audit. The scope is the change: the files the working tree differs in
 * from the base, and the files git does not know yet. `--all` audits the
 * whole project instead, and `--base <ref>` measures the change against
 * another ref.
 *
 * The command reads the mode of the project and says what it means: in
 * `after` the hook does nothing and this report is the only one there is,
 * and in `during` the hook reports on every write and this is a snapshot
 * of the scope.
 *
 * The exit code follows the floor rule of the gate: a change with an open
 * floor finding does not pass, and the command says so with a non-zero
 * exit. A change with only reflex findings open passes, because a reflex
 * finding is a tell that a person may waive.
 */

/** What the audit looks at. */
export type AuditScope = 'changed' | 'all';

/** What the caller knows about the audit. */
export interface AuditOptions {
  /** The scope: the files that changed, or the whole project. */
  scope?: AuditScope | undefined;
  /** The ref the change is measured against. */
  base?: string | undefined;
}

/** What the audit found. */
export interface AuditReport {
  /** The project root. */
  root: string;
  /** The scope that was audited. */
  scope: AuditScope;
  /** The ref the change was measured against. */
  base: string;
  /** When the check runs in this project. */
  mode: 'during' | 'after';
  /** The files in the scope. */
  files: string[];
  /** The files the check read. */
  checked: string[];
  /** Every finding, the waived ones included. */
  findings: Finding[];
  /** The findings no waiver covers, the floor ones first. */
  open: Finding[];
  /** The findings a waiver covers. */
  waived: Finding[];
  /** Which path ran. */
  path: SloplintPath;
  /** Why the linter did not deliver, when it did not. */
  degraded?: SloplintDegradation | undefined;
  /** The open findings of the floor. */
  floor: number;
  /** The open findings of the reflex tier. */
  reflex: number;
  /** The open findings of the taste tier. */
  finish: number;
  /** The exit code the command returns. */
  exitCode: number;
  /** Why the scope is what it is, when the scope is not what was asked for. */
  problem?: string | undefined;
}

/**
 * The directories the walk does not enter.
 *
 * They hold no source: the built output, the dependencies, the state of
 * the board and the files the build generated.
 */
const SKIPPED_DIRS = new Set([
  '.git',
  '.openagentsy',
  '.opencode',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
  'vendor',
]);

/**
 * The git options the scope reads the repository with.
 *
 * The fsmonitor hook is off: the scope is a list of file names, and a
 * machine whose fsmonitor daemon is not running must still be able to ask
 * what changed. The hook answers with an error, and the audit would report
 * an empty scope instead of the change.
 */
const GIT_OPTIONS = ['-c', 'core.fsmonitor=false'];

/** The order the tiers are read in: the floor first, the taste last. */
const TIER_ORDER: Record<Finding['tier'], number> = { floor: 0, reflex: 1, finish: 2 };

/** What each degradation means, in one line. */
const DEGRADATION_TEXT: Record<SloplintDegradation, string> = {
  absent: 'the Hallmark linter is not installed, so the static rules ran alone',
  'no-files': 'the scope has no page or stylesheet in it, so the linter had nothing to read',
  crashed: 'the linter failed, so the static findings stand',
  timeout: 'the linter ran too long, so the static findings stand',
  unparsable: 'the linter said something the bridge cannot read, so the static findings stand',
};

/**
 * The audit.
 */
export async function runAudit(
  roots: ProjectRoots,
  options: AuditOptions = {},
): Promise<AuditReport> {
  const { workspace, stateRoot } = roots;
  const scope = options.scope ?? 'changed';
  const base = options.base ?? 'HEAD';
  const resolved =
    scope === 'all' ? { files: await projectFiles(workspace) } : changedFiles(workspace, base);
  const mode = await readQualityMode(workspace);
  // The waivers are the state root's: a waiver is a decision about the
  // project, and a worktree of the project has the same waivers as the
  // project. The files are the workspace's: they are the files of the
  // branch under audit.
  const waivers = await loadWaiverLookup(stateRoot);
  const result = await runQualityAudit({ root: workspace, files: resolved.files, waivers });
  return reportOf({ root: workspace, scope, base, mode, result, ...resolved });
}

/** What the report is made of. */
interface ReportInput {
  root: string;
  scope: AuditScope;
  base: string;
  mode: 'during' | 'after';
  result: Awaited<ReturnType<typeof runQualityAudit>>;
  files: string[];
  problem?: string | undefined;
}

/** The report of a run. */
function reportOf(input: ReportInput): AuditReport {
  const open = [...input.result.open].sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier]);
  const floor = open.filter((finding) => finding.tier === 'floor').length;
  const reflex = open.filter((finding) => finding.tier === 'reflex').length;
  const finish = open.filter((finding) => finding.tier === 'finish').length;
  return {
    root: input.root,
    scope: input.scope,
    base: input.base,
    mode: input.mode,
    files: input.files,
    checked: input.result.files,
    findings: input.result.findings,
    open,
    waived: input.result.waived,
    path: input.result.path,
    ...(input.result.degraded !== undefined ? { degraded: input.result.degraded } : {}),
    floor,
    reflex,
    finish,
    exitCode: floor > 0 ? 1 : 0,
    ...(input.problem !== undefined ? { problem: input.problem } : {}),
  };
}

/**
 * The files that changed.
 *
 * The scope is the change: the files the working tree differs in from the
 * base, and the files git does not know yet. A directory that is not a
 * repository has no changed files, and the report says so.
 */
function changedFiles(root: string, base: string): { files: string[]; problem?: string } {
  const inside = gitText(root, ['rev-parse', '--is-inside-work-tree']);
  if (inside === null || inside.trim() !== 'true') {
    return { files: [], problem: 'this directory is not a git repository, so the scope is empty' };
  }
  const diff = gitText(root, [...GIT_OPTIONS, 'diff', '--name-only', '--relative', base]);
  if (diff === null) {
    return { files: [], problem: `the base ${base} could not be read, so the scope is empty` };
  }
  const untracked = gitText(root, [...GIT_OPTIONS, 'ls-files', '--others', '--exclude-standard']);
  return { files: unique([...lines(diff), ...lines(untracked ?? '')]) };
}

/**
 * The files of the whole project.
 *
 * The walk skips the directories that hold no source. What it finds is
 * every file in the project, and the check reads the ones a rule applies
 * to.
 */
async function projectFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await walk(root, '', files);
  return files;
}

/** The files of a directory, and of the directories under it. */
async function walk(root: string, dir: string, files: string[]): Promise<void> {
  const entries = await entriesOf(join(root, dir));
  for (const entry of entries) {
    const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      await walk(root, path, files);
      continue;
    }
    if (entry.isFile()) files.push(path);
  }
}

/** The entries of a directory, when it can be read. */
async function entriesOf(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** The paths of a git answer, one per line. */
function lines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** The paths, without the ones that came twice. */
function unique(paths: string[]): string[] {
  return [...new Set(paths)];
}

/**
 * The quality mode of the project.
 *
 * The mode says when the check runs: `during` runs it after every write,
 * and `after` leaves the findings to this command. A project that names no
 * mode runs the check after every write, which is the default.
 */
async function readQualityMode(root: string): Promise<'during' | 'after'> {
  const config = await readJsoncFile(join(root, 'openagentsy.jsonc'));
  const quality = asRecord(config?.quality);
  const mode = quality?.mode;
  return mode === 'after' ? 'after' : 'during';
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

/** A value, when it is an object. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * The report, as it is read.
 */
export function formatAuditReport(report: AuditReport): string {
  const lines: string[] = [];
  lines.push(
    `Audit of ${report.files.length} ${scopeWord(report.scope)} (${report.checked.length} checked)`,
  );
  lines.push(`  path   ${report.path} — ${DEGRADATION_TEXT[report.degraded ?? 'absent']}`);
  lines.push(`  mode   ${report.mode} — ${modeText(report.mode)}`);
  lines.push(`  open   ${report.floor} floor, ${report.reflex} reflex, ${report.finish} taste`);
  lines.push(`  waived ${report.waived.length}`);
  if (report.problem !== undefined) lines.push(`  ${report.problem}`);
  lines.push('');
  for (const finding of report.open) lines.push(findingLine(finding.tier, finding));
  for (const finding of report.waived) lines.push(findingLine('waived', finding));
  if (report.findings.length === 0) {
    lines.push('no findings: the scope is clean');
    lines.push('');
  }
  lines.push(verdictText(report));
  if (report.reflex > 0) {
    lines.push(`${report.reflex} open reflex findings: fix them or waive them`);
  }
  return `${lines.join('\n')}\n`;
}

/** The word for the scope. */
function scopeWord(scope: AuditScope): string {
  return scope === 'all' ? 'files in the project' : 'changed files';
}

/** The mode, and what it means for this report. */
function modeText(mode: 'during' | 'after'): string {
  if (mode === 'after') return 'the hook is off, so this report is the only one there is';
  return 'the hook reports on every write; this report is a snapshot of the scope';
}

/** One finding, one line. */
function findingLine(tier: string, finding: Finding): string {
  return `  ${tier.padEnd(6)} ${finding.ruleId.padEnd(24)} ${finding.file}:${finding.line}  ${finding.fix}`;
}

/** The verdict of the floor rule. */
function verdictText(report: AuditReport): string {
  if (report.floor > 0) {
    return `${report.floor} open floor findings: the change does not pass the gate`;
  }
  return 'no open floor findings: the change passes the gate';
}
