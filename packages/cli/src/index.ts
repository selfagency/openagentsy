#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { formatApproveResult, runApprove } from './commands/approve.js';
import { formatBoard, runBoard } from './commands/board.js';
import { runBuild } from './commands/build.js';
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
import { runSetup } from './commands/setup.js';

const USAGE = `openagentsy <command> [options]

Commands:
  audit              Report the quality findings of the change, and say which path ran
  board              Show the records, leases and budgets, for a human to read
  build              Generate the agent, command and skill files
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
  models switch      Switch the provider, re-pick the models, and write the lock file

Options:
  --root <dir>        Project root (default: current directory)
  --all               Audit the whole project instead of the changed files
  --base <ref>        The ref the changed files are measured against (default: HEAD)
  --since <when>      How far back to look (default: 30 days ago)
  --out <dir>         Output directory for build (default: <root>/.opencode)
  --roles <file>      Roles file (default: <root>/roles.yaml)
  --lock <file>       Model lock file (default: <root>/openagentsy.models.lock.json)
  --config <file>     Config file for setup (default: <root>/opencode.json)
  --providers <list>  Providers for models init, comma separated
  --prefer-flash      Take the flash variant of the family a role would get
  --allow-training    Allow models whose terms train on prompts
  --allow-retention   Allow models that are not zero data retention
  --key <key>         BenchLM key, for the keyed REST API
  --yes               Write the lock file without asking
  --json              Write the output as JSON (ledger)
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
  help?: boolean | undefined;
};

async function buildCommand(root: string, values: Values): Promise<number> {
  const result = await runBuild({
    root,
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
async function auditCommand(root: string, values: Values): Promise<number> {
  const { formatAuditReport, runAudit } = await import('./commands/audit.js');
  const report = await runAudit(root, {
    scope: values.all === true ? 'all' : 'changed',
    ...(values.base === undefined ? {} : { base: values.base }),
  });
  process.stdout.write(formatAuditReport(report));
  return report.exitCode;
}

async function boardCommand(root: string): Promise<number> {
  const view = await runBoard(root);
  process.stdout.write(`${formatBoard(view)}\n`);
  return 0;
}

async function doctorCommand(root: string): Promise<number> {
  const report = await runDoctor(root);
  process.stdout.write(formatDoctorReport(report));
  return 0;
}

async function ledgerCommand(root: string, values: Values, positionals: string[]): Promise<number> {
  const sub = positionals[1];
  const since = values.since;

  if (sub === 'scan-reverts') {
    const report = await runLedgerScanReverts(root, since === undefined ? {} : { since });
    process.stdout.write(formatScanRevertsReport(report));
    return 0;
  }
  if (sub === 'outcomes') {
    const report = await runLedgerOutcomes(root, since === undefined ? {} : { since });
    process.stdout.write(formatOutcomesReport(report));
    return 0;
  }
  if (sub === 'waste') {
    const report = await runLedgerWaste(root, since === undefined ? {} : { since });
    process.stdout.write(formatWasteReport(report));
    return 0;
  }
  if (sub !== undefined && sub !== 'export') {
    process.stderr.write(`unknown ledger subcommand: ${sub}\n`);
    return 1;
  }

  const report = await runLedger(root);
  if (sub === 'export' || values.json === true) {
    process.stdout.write(`${JSON.stringify(report.counters, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(formatLedgerReport(report));
  return 0;
}

async function setupCommand(root: string, values: Values): Promise<number> {
  const result = await runSetup({
    root,
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

async function modelsCommand(root: string, values: Values, positionals: string[]): Promise<number> {
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
    root,
    mode: sub,
    providers: requested,
    ...(values['prefer-flash'] ? { preferFlash: true } : {}),
    ...(values['allow-training'] ? { allowTraining: true } : {}),
    ...(values['allow-retention'] ? { allowRetention: true } : {}),
    ...(values.key ? { key: values.key } : {}),
    ...(values.yes ? { yes: true } : {}),
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
async function lessonsCommand(root: string): Promise<number> {
  const report = await runLessons(root);
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
  root: string,
  _values: Values,
  positionals: string[],
): Promise<number> {
  const id = positionals[1];
  const action = positionals[2];
  if (id === undefined || action === undefined) {
    process.stderr.write('usage: openagentsy lesson <id> <validate|apply|reject|observe>\n');
    return 1;
  }
  const report = await runLessonDecision(root, id, action);
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
async function waiveCommand(root: string, _values: Values, positionals: string[]): Promise<number> {
  const ruleId = positionals[1];
  const path = positionals[2];
  const reason = positionals.slice(3).join(' ');
  if (ruleId === undefined || path === undefined || reason === '') {
    process.stderr.write('usage: openagentsy waive <ruleId> <path> "<reason>"\n');
    return 1;
  }
  const { formatWaiver, runWaiver } = await import('./commands/waivers.js');
  const report = await runWaiver(root, ruleId, path, reason);
  process.stdout.write(formatWaiver(report));
  return report.ok ? 0 : 1;
}

/**
 * Grant one call the permission it asked for.
 */
async function approveCommand(
  root: string,
  values: Values,
  positionals: string[],
): Promise<number> {
  const result = await runApprove({
    root,
    ...(positionals[1] === undefined ? {} : { callID: positionals[1] }),
    ...(values.ttl === undefined ? {} : { ttl: values.ttl }),
  });
  process.stdout.write(formatApproveResult(result));
  return result.ok ? 0 : 1;
}

/** The command table. One entry per command, so the dispatch is a lookup. */
const COMMANDS: Record<
  string,
  (root: string, values: Values, positionals: string[]) => Promise<number>
> = {
  build: buildCommand,
  audit: auditCommand,
  board: boardCommand,
  doctor: doctorCommand,
  ledger: ledgerCommand,
  lessons: lessonsCommand,
  lesson: lessonCommand,
  waive: waiveCommand,
  approve: approveCommand,
  setup: setupCommand,
  models: modelsCommand,
};

/**
 * Run the CLI.
 *
 * The commands are a table and the options are parsed in one place, so this
 * function stays small enough to read.
 */
export async function main(argv: string[]): Promise<number> {
  // The board's driver is bun:sqlite, so the whole tool needs Bun. A Node
  // install fails at the first query, and the message here says which
  // runtime to use instead of showing a module resolution error.
  if (!process.versions.bun) {
    process.stderr.write(
      'openagentsy runs on Bun: the board uses bun:sqlite, which Node does not have.\nRun it with: bunx openagentsy@0.1.0 <command>\n',
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
      help: { type: 'boolean', short: 'h' },
    },
  });

  const command = positionals[0];
  const root = values.root ?? process.cwd();

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

  return handler(root, values, positionals);
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
