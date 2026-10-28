import {
  buildConformanceReport,
  type ConformanceFacts,
  ethicalReportJson,
  type ProjectRoots,
  type ReportFacts,
  renderEthicalReport,
} from '@openagentsy/core';
import { loadWaiverLookup } from '@openagentsy/hooks/quality/waivers';
import { acceptGate, readFindings, type TaskFindings } from '@openagentsy/quality';
import { ledgerFacts } from '../report/ledger.js';
import { oversightFacts, scopedFindings } from '../report/oversight.js';
import { parseScope } from '../report/scope.js';

/**
 * `oa report --ethical`: what the run cost, and what it was worth (§12).
 *
 * The report is a rendering of facts that were read from the ledger, the
 * board, the stores and the conformance report. It writes nothing, it
 * reaches no network, and it judges nobody: it says what happened.
 *
 * The `--check` flag makes the report a gate. The rule it applies is the
 * quality package's own: a ship verdict with an open floor finding is a
 * fabricated pass, and the gate refuses it. So the command asks the gate
 * whether a ship of this work would be accepted, and the answer is the
 * exit code.
 */

/** The options the command takes. */
export type ReportOptions = {
  /** The session, and the subagents that rolled up into it. */
  session?: string | undefined;
  /** The bean: the rows whose task is that bean. */
  bean?: string | undefined;
  /** The window, as a phrase: 30d, 30 days ago, 2 weeks ago. */
  since?: string | undefined;
  /** Whether the report is a gate. */
  check?: boolean | undefined;
};

/** The report, and what the command returns. */
export type EthicalReport = {
  /** The facts the report is rendered from. */
  facts: ReportFacts;
  /** The exit code the command returns. */
  exitCode: number;
  /** Why the gate refused, when it refused. */
  refusal?: string | undefined;
  /** The problem with the flags, when there is one. */
  problem?: string | undefined;
};

/**
 * The facts of a project with nothing in it.
 *
 * A command that cannot build a scope has no report to render, and the
 * problem it reports is the whole of its output.
 */
function emptyFacts(scope: ReportFacts['scope']): ReportFacts {
  return {
    scope,
    cost: {
      present: false,
      messages: 0,
      tokens: 0,
      roles: [],
      reportedUsd: null,
      estimatedUsd: null,
      unpricedModels: 0,
      unpricedMessages: 0,
    },
    footprint: {
      present: false,
      energyKwh: null,
      waterL: null,
      co2Kg: null,
      method: null,
      dominantUncertainty: null,
      grid: null,
      undisclosedProviders: 0,
    },
    waste: { present: false, tokens: 0, percentage: 0, byKind: [] },
    value: {
      present: false,
      tasksCompleted: 0,
      tasksScrapped: 0,
      commits: 0,
      prsMerged: 0,
      tokensPerTask: null,
      tokensPerCommit: null,
      offloadMessages: 0,
      offloadTokens: 0,
      offloadUsd: null,
      offloadCloudUsd: null,
      offloadSavedUsd: null,
    },
    oversight: {
      records: 0,
      lessons: 0,
      memory: 0,
      waivers: 0,
      auditEntries: 0,
      openFloor: 0,
      openFloorFindings: [],
      mismatches: { known: false, reason: 'no package compares the board with a report' },
      redactions: { known: false, reason: 'no package keeps a counter' },
    },
    conformance: {
      total: 0,
      observed: 0,
      provenStatic: 0,
      unverified: 0,
      unverifiedIds: [],
      pluginOrderWarnings: [],
    },
    policies: { present: false, firings: 0, top: [], neverFired: [] },
  };
}

/**
 * The conformance of the project, as the report shows it.
 *
 * The counts and the unverified capabilities are the conformance report of
 * §11, and the unverified ones are named: a guess about the host must not
 * read as a tested fact.
 */
async function conformanceFacts(roots: ProjectRoots): Promise<ConformanceFacts> {
  const report = await buildConformanceReport({
    workspace: roots.workspace,
    stateRoot: roots.stateRoot,
  });
  return {
    total: report.counts.total,
    observed: report.counts.observed,
    provenStatic: report.counts.proven_static,
    unverified: report.counts.unverified,
    unverifiedIds: report.capabilities
      .filter((capability) => capability.state === 'unverified')
      .map((capability) => capability.id),
    pluginOrderWarnings: report.pluginOrderWarnings.map((warning) => ({
      plugin: warning.plugin,
      detail: warning.detail,
    })),
  };
}

/**
 * The report.
 *
 * The scope names the rows the ledger is read for, the board records the
 * oversight counts, and the findings store the gate. Nothing is written.
 */
export async function runEthicalReport(
  roots: ProjectRoots,
  options: ReportOptions = {},
): Promise<EthicalReport> {
  const parsed = parseScope(options);
  if (!parsed.ok) {
    return { facts: emptyFacts({ kind: 'project' }), exitCode: 2, problem: parsed.error };
  }
  const scope = parsed.scope;

  const findings: TaskFindings = await readFindings(roots.stateRoot);
  const ledger = await ledgerFacts(roots.stateRoot, scope);
  const oversight = await oversightFacts(roots.stateRoot, scope, findings);
  const conformance = await conformanceFacts(roots);

  // The gate decides, not the report: the rule is the quality package's,
  // and the report asks it whether a ship of this work would be accepted.
  const waivers = await loadWaiverLookup(roots.stateRoot);
  const gate = acceptGate({
    raw: { verdict: 'ship' },
    findings: scopedFindings(findings, scope),
    waivers,
  });

  const facts: ReportFacts = {
    scope,
    cost: ledger.cost,
    footprint: ledger.footprint,
    waste: ledger.waste,
    value: ledger.value,
    oversight,
    conformance,
    policies: ledger.policies,
  };

  const refusing = !gate.accepted;
  return {
    facts,
    exitCode: options.check === true && refusing ? 1 : 0,
    ...(refusing
      ? { refusal: `the gate refuses the ship: ${gate.openFloor.length} floor findings are open` }
      : {}),
  };
}

/**
 * The report, as plain text.
 *
 * The text carries no colour, and a refusal is said in words rather than in
 * an exit code alone, so a reader of the output knows what happened.
 */
export function formatEthicalReport(report: EthicalReport): string {
  if (report.problem !== undefined) return `${report.problem}\n`;
  const text = renderEthicalReport(report.facts);
  if (report.refusal === undefined) return text;
  return `${text}\n${report.refusal}\n`;
}

/**
 * The report, as JSON.
 *
 * The same facts the text is rendered from, so the two can never disagree.
 */
export function ethicalReportAsJson(report: EthicalReport): string {
  return `${JSON.stringify(ethicalReportJson(report.facts), null, 2)}\n`;
}
