#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { type ProjectRoots, resolveProjectRoots } from '@openagentsy/core';
import type { FetchLike } from '@openagentsy/models';
import { formatApproveResult, runApprove } from './commands/approve.js';
import { formatBoard, runBoard } from './commands/board.js';
import { runBuild } from './commands/build.js';
import { formatConformanceReport, runConformance } from './commands/conformance.js';
import { formatDoctorReport, runDoctor } from './commands/doctor.js';
import {
  formatLedgerReport,
  formatOutcomesReport,
  formatScanRevertsReport,
  formatWasteReport,
  runLedger,
  runLedgerOutcomes,
  runLedgerScanReverts,
  runLedgerWaste,
} from './commands/ledger.js';
import {
  formatLessonDecision,
  formatLessonsReport,
  runLessonDecision,
  runLessons,
} from './commands/lessons.js';
import { runModels, type SwitchTouches } from './commands/models.js';
import { ethicalReportAsJson, formatEthicalReport, runEthicalReport } from './commands/report.js';
import { formatScope, runScope } from './commands/scope.js';
import { runSetup } from './commands/setup.js';

const USAGE = `openagentsy <command> [options]

Two roots: the directory the command runs in, and the state root of the
project. The state root is the main repository root, so a command run in a
linked worktree reads the board, the ledger and the lock of the project.

Commands:
  audit              Report the quality findings of the change, and say which path ran
  board              Show the records, leases and budgets, for a human to read
  build              Generate the agent, command and skill files
  conformance        Report what is proven, observed or unverified
  doctor             Report what is installed, where it came from, and what is missing
  ledger             Show the tokens, the cost and the waste of the work
  ledger export      Write the counters of the ledger as JSON
  ledger waste       Find the waste that can be found, and say what the waste is
  ledger scan-reverts  Find the code that was written and then taken back
  ledger outcomes    Find the commits that name a task, and the Refs trailers they carry
  lessons            Show the lessons that are waiting for a decision
  lesson <id> <act>  Decide a lesson: validate, apply, reject or observe
  waive <ruleId> <path> <reason>
                        Record a quality waiver, as a person
  approve <callID>   Grant one call the permission it asked for
  setup              Write the OpenCode config for OpenAgentsy
  models init        Pick a model for every role and write the model lock file
  models refresh     Re-pick the models with the providers the lock records, and write the lock file
  models switch        Switch the provider, re-pick the models, and write the lock file
  report --ethical     Report what the run cost, and what it was worth
  scope [role]         Print the scope declaration of a role, or of every role
Options:
  --root <dir>        Project directory (default: current directory)
  --all               Audit the whole project instead of the changed files
  --base <ref>        The ref the changed files are measured against (default: HEAD)
  --since <when>      How far back to look (default: 30 days ago)
  --session <id>      Report one session, and the subagents that rolled up into it
  --bean <id>         Report one bean: the rows whose task is that bean
  --check             Exit nonzero when a floor finding is open
  --ethical           Report the run in the form of §12
  --out <dir>         Output directory for build (default: <root>/.opencode)
  --roles <file>      Roles file (default: <root>/roles.yaml)
  --lock <file>       Model lock file (default: <state root>/openagentsy.models.lock.json)
  --config <file>     Config file for setup (default: <root>/opencode.json)
  --providers <list>  Providers for models init, comma separated
  --prefer-flash      Take the flash variant of the family a role would get
  --allow-training    Allow models whose terms train on prompts
  --allow-retention   Allow models that are not zero data retention
  --key <key>         BenchLM key, for the keyed REST API
  --yes               Write the lock file without asking
  --json              Write the output as JSON (ledger, conformance)
  --ttl <ms>          How long a grant lives (default: 15 minutes, max: 1 day)
  --dry-run           Print what setup would write without writing it
  --magic-context     Turn OpenCode's compaction off, for a project with a
                      memory integration that shrinks the context itself
  -h, --help          Show this help
`;

/** The parsed options. The names are the ones the usage card names. */
export type Values = {
  root?: string | undefined;
  since?: string | undefined;
  out?: string | undefined;
  roles?: string | undefined;
  lock?: string | undefined;
  config?: string | undefined;
  providers?: string | undefined;
  key?: string | undefined;
  all?: boolean | undefined;
  base?: string | undefined;
  'dry-run'?: boolean | undefined;
  'magic-context'?: boolean | undefined;
  'prefer-flash'?: boolean | undefined;
  'allow-training'?: boolean | undefined;
  'allow-retention'?: boolean | undefined;
  yes?: boolean | undefined;
  json?: boolean | undefined;
  ttl?: string | undefined;
  session?: string | undefined;
  bean?: string | undefined;
  ethical?: boolean | undefined;
  check?: boolean | undefined;
  help?: boolean | undefined;
};

async function buildCommand(roots: ProjectRoots, values: Values): Promise<number> {
  const result = await runBuild({
    workspace: roots.workspace,
    stateRoot: roots.stateRoot,
    ...(values.out ? { outDir: values.out } : {}),
    ...(values.roles ? { rolesPath: values.roles } : {}),
    ...(values.lock ? { lockPath: values.lock } : {}),
  });
  process.stdout.write('built\n');
  process.stdout.write(`  agents   ${result.agents.length}\n`);
  process.stdout.write(`  commands ${result.commands.join(', ')}\n`);
  process.stdout.write(`  skills   ${result.skills.join(', ') || 'none'}\n`);
  for (const warning of result.warnings) {
    process.stdout.write(`  warning: ${warning}\n`);
  }
  return 0;
}

/**
 * The audit of the change.
 *
 * The command is loaded on demand. The audit runs the whole rule set, and
 * the whole rule set carries the TypeScript compiler; the other commands
 * must not pay for it.
 */
async function auditCommand(roots: ProjectRoots, values: Values): Promise<number> {
  const { formatAuditReport, runAudit } = await import('./commands/audit.js');
  const report = await runAudit(roots, {
    scope: values.all === true ? 'all' : 'changed',
    ...(values.base === undefined ? {} : { base: values.base }),
  });
  process.stdout.write(formatAuditReport(report));
  return report.exitCode;
}

async function boardCommand(roots: ProjectRoots): Promise<number> {
  const view = await runBoard(roots.stateRoot);
  process.stdout.write(`${formatBoard(view)}\n`);
  return 0;
}

async function doctorCommand(roots: ProjectRoots): Promise<number> {
  const report = await runDoctor(roots);
  process.stdout.write(formatDoctorReport(report));
  return 0;
}

/**
 * The conformance report.
 *
 * The report says what is proven, observed or unverified, one capability at
 * a time, and it shows the evidence of an observed capability.
 */
async function conformanceCommand(roots: ProjectRoots, values: Values): Promise<number> {
  const report = await runConformance(roots);
  if (values.json === true) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(formatConformanceReport(report));
  return 0;
}

async function ledgerCommand(
  roots: ProjectRoots,
  values: Values,
  positionals: string[],
): Promise<number> {
  const sub = positionals[1];
  const since = values.since;

  if (sub === 'scan-reverts') {
    const report = await runLedgerScanReverts(roots, since === undefined ? {} : { since });
    process.stdout.write(formatScanRevertsReport(report));
    return 0;
  }
  if (sub === 'outcomes') {
    const report = await runLedgerOutcomes(roots, since === undefined ? {} : { since });
    process.stdout.write(formatOutcomesReport(report));
    return 0;
  }
  if (sub === 'waste') {
    const report = await runLedgerWaste(roots.stateRoot, since === undefined ? {} : { since });
    process.stdout.write(formatWasteReport(report));
    return 0;
  }
  if (sub !== undefined && sub !== 'export') {
    process.stderr.write(`unknown ledger subcommand: ${sub}\n`);
    return 1;
  }

  const report = await runLedger(roots.stateRoot);
  if (sub === 'export' || values.json === true) {
    process.stdout.write(`${JSON.stringify(report.counters, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(formatLedgerReport(report));
  return 0;
}

/**
 * The ethical report (§12).
 *
 * The report is local: it reads the ledger, the board and the stores of the
 * state root, it writes nothing, and it reaches no network. The `--check`
 * flag makes it a gate, and the exit code is the gate's answer.
 */
async function reportCommand(roots: ProjectRoots, values: Values): Promise<number> {
  const report = await runEthicalReport(roots, {
    ...(values.session === undefined ? {} : { session: values.session }),
    ...(values.bean === undefined ? {} : { bean: values.bean }),
    ...(values.since === undefined ? {} : { since: values.since }),
    ...(values.check === true ? { check: true } : {}),
  });
  if (values.json === true) {
    process.stdout.write(ethicalReportAsJson(report));
    return report.exitCode;
  }
  process.stdout.write(formatEthicalReport(report));
  return report.exitCode;
}

async function setupCommand(roots: ProjectRoots, values: Values): Promise<number> {
  const result = await runSetup({
    root: roots.workspace,
    ...(values.config ? { configPath: values.config } : {}),
    ...(values['dry-run'] ? { dryRun: true } : {}),
    ...(values['magic-context'] ? { magicContext: true } : {}),
  });
  process.stdout.write(`${result.dryRun ? 'would write' : 'wrote'} ${result.configPath}\n`);
  for (const key of result.changed) {
    process.stdout.write(`  ${key}\n`);
  }
  if (result.merged && result.merged.length > 0) {
    process.stdout.write(
      `  OpenCode merges this with ${result.merged.join(', ')}, which was not read. Review it after setup.\n`,
    );
  }
  if (result.pluginPath) {
    process.stdout.write(
      `  ${result.dryRun ? 'would install' : 'installed'} ${result.pluginPath}\n`,
    );
  } else {
    process.stdout.write('  no plugin bundle found, run: bun run build\n');
  }
  if (result.dryRun) {
    process.stdout.write('\n');
    process.stdout.write(result.content);
  }
  return 0;
}

/** The model report, one role at a time. */
function reportModels(
  changes: {
    role: string;
    from?: string | undefined;
    to: string;
    note: string;
  }[],
  rejected: Record<string, { openCodeId: string; reason: string }[]>,
  failures: Record<string, string>,
): void {
  process.stdout.write(`model selection for ${changes.length} roles\n`);
  for (const change of changes) {
    const from = change.from !== undefined && change.from !== change.to ? `${change.from} -> ` : '';
    process.stdout.write(`  ${change.role.padEnd(12)}${from}${change.to}\n`);
    process.stdout.write(`               ${change.note}\n`);
    for (const rejection of (rejected[change.role] ?? []).slice(0, 3)) {
      process.stdout.write(`               not ${rejection.openCodeId}: ${rejection.reason}\n`);
    }
  }
  for (const [role, reason] of Object.entries(failures)) {
    process.stdout.write(`  ${role.padEnd(12)}no model available\n`);
    process.stdout.write(`               ${reason}\n`);
  }
}

/** What the switch touches besides the lock file. */
function reportTouches(touches: SwitchTouches): void {
  process.stdout.write('\nthe switch touches more than the lock:\n');
  process.stdout.write(`  the agent files are stale: run ${touches.rebuild} to regenerate them\n`);
  process.stdout.write(
    `  CI takes its model from the lock: the next run uses ${touches.providers.join(', ')}\n`,
  );
  if (touches.keys.length === 0) {
    process.stdout.write('  the provider needs no key\n');
    return;
  }
  const subject =
    touches.keys.length === 1 ? 'the provider needs its key' : 'the providers need their keys';
  process.stdout.write(
    `  ${subject}: ${touches.keys.join(', ')}, in the auth store locally and as a CI secret of the same name\n`,
  );
}

async function modelsCommand(
  roots: ProjectRoots,
  values: Values,
  positionals: string[],
  options: CommandOptions,
): Promise<number> {
  const sub = positionals[1] ?? 'init';
  if (sub !== 'init' && sub !== 'refresh' && sub !== 'switch') {
    process.stderr.write(`unknown models subcommand: ${sub}\n`);
    return 1;
  }

  // The providers come from the positionals and from the flag, so both
  // `models switch ollama-cloud` and `models switch --providers ollama-cloud`
  // name the provider.
  const requested = [...positionals.slice(2), ...(values.providers?.split(',') ?? [])];

  const result = await runModels({
    workspace: roots.workspace,
    stateRoot: roots.stateRoot,
    mode: sub,
    providers: requested,
    ...(values['prefer-flash'] ? { preferFlash: true } : {}),
    ...(values['allow-training'] ? { allowTraining: true } : {}),
    ...(values['allow-retention'] ? { allowRetention: true } : {}),
    ...(values.key ? { key: values.key } : {}),
    ...(values.yes ? { yes: true } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  reportModels(result.changes, result.rejected, result.failures);
  if (result.touches) {
    reportTouches(result.touches);
  }
  process.stdout.write(
    result.written
      ? `\nwrote ${result.path}\n`
      : `\nnot written, pass --yes to write ${result.path}\n`,
  );
  return 0;
}

/**
 * The lessons that are waiting for a decision.
 */
async function lessonsCommand(roots: ProjectRoots): Promise<number> {
  const report = await runLessons(roots.stateRoot);
  process.stdout.write(formatLessonsReport(report));
  return 0;
}

/**
 * A decision about one lesson.
 *
 * The person running the command is the decider: a lesson changes state
 * only when a person says so.
 */
async function lessonCommand(
  roots: ProjectRoots,
  _values: Values,
  positionals: string[],
): Promise<number> {
  const id = positionals[1];
  const action = positionals[2];
  if (id === undefined || action === undefined) {
    process.stderr.write('usage: openagentsy lesson <id> <validate|apply|reject|observe>\n');
    return 1;
  }
  const report = await runLessonDecision(roots.stateRoot, id, action);
  process.stdout.write(formatLessonDecision(report));
  return report.ok ? 0 : 1;
}

/**
 * Record a quality waiver.
 *
 * The person running the command is the decider, and the command is the
 * way a waiver is recorded: the tool the board server registers is denied
 * to every agent role by the permission map, so an agent may propose a
 * waiver in chat and never record one.
 *
 * The command is loaded on demand. The waiver check asks the whole rule
 * set whether a rule may be waived, and the whole rule set carries the
 * TypeScript compiler; the other commands must not pay for it.
 */
async function waiveCommand(
  roots: ProjectRoots,
  _values: Values,
  positionals: string[],
): Promise<number> {
  const ruleId = positionals[1];
  const path = positionals[2];
  const reason = positionals.slice(3).join(' ');
  if (ruleId === undefined || path === undefined || reason === '') {
    process.stderr.write('usage: openagentsy waive <ruleId> <path> "<reason>"\n');
    return 1;
  }
  const { formatWaiver, runWaiver } = await import('./commands/waivers.js');
  const report = await runWaiver(roots.stateRoot, ruleId, path, reason);
  process.stdout.write(formatWaiver(report));
  return report.ok ? 0 : 1;
}

/**
 * Grant one call the permission it asked for.
 */
async function approveCommand(
  roots: ProjectRoots,
  values: Values,
  positionals: string[],
): Promise<number> {
  const result = await runApprove({
    stateRoot: roots.stateRoot,
    ...(positionals[1] === undefined ? {} : { callID: positionals[1] }),
    ...(values.ttl === undefined ? {} : { ttl: values.ttl }),
  });
  process.stdout.write(formatApproveResult(result));
  return result.ok ? 0 : 1;
}

/**
 * What the caller can inject into a run.
 *
 * The models command reaches the network for the provider catalogue, so the
 * test that exercises it needs a fetch of its own. A test that reaches
 * models.dev is a test whose time depends on a machine's connection.
 */
export type CommandOptions = { fetchImpl?: FetchLike };

/**
 * The scope declarations of the roles (§22.3).
 *
 * The command is a person's: the declarations are there to be read, and the
 * refusal a role makes is built from the same text.
 */
async function scopeCommand(
  _roots: ProjectRoots,
  _values: Values,
  positionals: string[],
): Promise<number> {
  const report = runScope(positionals[1]);
  if (report.unknownRole !== undefined) {
    process.stderr.write(formatScope(report));
    return 1;
  }
  process.stdout.write(formatScope(report));
  return 0;
}

/** The command table. One entry per command, so the dispatch is a lookup. */
const COMMANDS: Record<
  string,
  (
    roots: ProjectRoots,
    values: Values,
    positionals: string[],
    options: CommandOptions,
  ) => Promise<number>
> = {
  build: buildCommand,
  audit: auditCommand,
  board: boardCommand,
  conformance: conformanceCommand,
  doctor: doctorCommand,
  ledger: ledgerCommand,
  lessons: lessonsCommand,
  lesson: lessonCommand,
  waive: waiveCommand,
  approve: approveCommand,
  setup: setupCommand,
  models: modelsCommand,
  report: reportCommand,
  scope: scopeCommand,
};

/**
 * Run the CLI.
 *
 * The commands are a table and the options are parsed in one place, so this
 * function stays small enough to read.
 */
/**
 * The version this package carries.
 *
 * The manifest is the record, and a literal in the source goes stale the
 * moment the release machinery bumps it. The manifest sits one directory
 * above the build output, and the file is read at the point where the
 * version is needed, so a package that cannot find it says so rather than
 * naming a version that does not exist.
 */
function packageVersion(): string {
  try {
    const manifest = new URL('../package.json', import.meta.url);
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export async function main(argv: string[], options: CommandOptions = {}): Promise<number> {
  // The board's driver is bun:sqlite, so the whole tool needs Bun. A Node
  // install fails at the first query, and the message here says which
  // runtime to use instead of showing a module resolution error.
  if (!process.versions.bun) {
    process.stderr.write(
      `openagentsy runs on Bun: the board uses bun:sqlite, which Node does not have.\nRun it with: bunx @voxslopuli/openagentsy@${packageVersion()} <command>\n`,
    );
    return 1;
  }

  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      root: { type: 'string' },
      since: { type: 'string' },
      out: { type: 'string' },
      roles: { type: 'string' },
      lock: { type: 'string' },
      config: { type: 'string' },
      'dry-run': { type: 'boolean' },
      'magic-context': { type: 'boolean' },
      providers: { type: 'string' },
      all: { type: 'boolean' },
      base: { type: 'string' },
      'prefer-flash': { type: 'boolean' },
      'allow-training': { type: 'boolean' },
      'allow-retention': { type: 'boolean' },
      key: { type: 'string' },
      yes: { type: 'boolean' },
      json: { type: 'boolean' },
      ttl: { type: 'string' },
      session: { type: 'string' },
      bean: { type: 'string' },
      ethical: { type: 'boolean' },
      check: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  const command = positionals[0];

  if (values.help === true || command === undefined) {
    process.stdout.write(USAGE);
    return command === undefined && values.help !== true ? 1 : 0;
  }

  const handler = COMMANDS[command];
  if (handler === undefined) {
    process.stderr.write(`unknown command: ${command}\n\n`);
    process.stderr.write(USAGE);
    return 1;
  }

  // The two roots of the command: the directory it runs in, and the
  // directory that owns the shared state of the project. In a linked
  // worktree the second is the main repository root.
  const roots = resolveProjectRoots(values.root ?? process.cwd());

  return handler(roots, values, positionals, options);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
