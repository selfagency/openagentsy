import type {
  ConformanceFacts,
  CostFacts,
  FootprintFacts,
  Measured,
  OversightFacts,
  PolicyFacts,
  ReportFacts,
  ReportRange,
  ReportScope,
  ValueFacts,
  WasteFacts,
} from './types.js';

/**
 * The report, as a person reads it (§12).
 *
 * One screen of plain text: no colour, no judgment of the person, and no
 * number that is not traceable to a table. A reader who wants to know where
 * a number came from finds the table named in the section it is in, and a
 * number nobody could measure is absent rather than zero.
 */

/** The title of the report. */
const TITLE = 'OpenAgentsy run report';

/**
 * The scope, in words.
 *
 * The window is named with the scope, because a report without a window is
 * a report about everything and says so.
 */
function scopeLabel(scope: ReportScope): string {
  switch (scope.kind) {
    case 'project':
      return 'project, the whole ledger';
    case 'session':
      return `session ${scope.id}, that session and its subagents`;
    case 'bean':
      return `bean ${scope.id}, the rows whose task is that bean`;
    case 'since':
      return `the last ${scope.label}`;
  }
}

/** The tokens, in the short form a person reads at a glance. */
function tokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

/** The money, or the word for money nobody knows. */
function money(usd: number | null): string {
  if (usd === null) return 'unpriced';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** A number of two significant figures, so a range reads as a range. */
function bound(value: number): string {
  if (value >= 100) return value.toFixed(0);
  if (value >= 0.1) return value.toFixed(1);
  return value.toFixed(2);
}

/** A range with its unit, or the words for a range nobody measured. */
function range(value: ReportRange | null, unit: string): string {
  if (value === null) return `not computed for the scope`;
  return `${bound(value[0])}–${bound(value[1])} ${unit}`;
}

/** A count, with the word that goes with it. */
function count(value: number, one: string, many: string): string {
  return `${value} ${value === 1 ? one : many}`;
}

/** The things of a list, separated by a middot. */
function joined(values: readonly string[]): string {
  return values.join(' · ');
}

/**
 * The cost, and the footprint.
 *
 * The tokens and the spend are the ledger's `usage` table. The bounds are
 * the ledger's `footprint` table, and the method is the one the estimator
 * wrote on the row.
 */
function costLines(cost: CostFacts, footprint: FootprintFacts): string[] {
  const lines: string[] = [];
  if (!cost.present) {
    lines.push('  tokens by role: none — the scope holds no usage rows');
    lines.push('  spend: nothing to price');
  } else {
    const roles =
      cost.roles.length === 0
        ? 'none — every row of the scope is unattributed'
        : joined(cost.roles.map((role) => `${role.role} ${tokens(role.tokens)}`));
    lines.push(`  tokens by role: ${roles}`);
    const priced = cost.reportedUsd !== null || cost.estimatedUsd !== null;
    const spend = priced
      ? joined([
          `${money(cost.reportedUsd)} reported`,
          `${money(cost.estimatedUsd)} estimated`,
          `${count(cost.unpricedModels, 'model', 'models')} unpriced`,
        ])
      : `nothing to price — ${count(cost.unpricedModels, 'model', 'models')} carry no price`;
    lines.push(`  spend: ${spend}`);
  }

  if (footprint.present) {
    lines.push(
      `  electricity ${range(footprint.energyKwh, 'kWh')} · water ${range(footprint.waterL, 'L')} · carbon ${range(footprint.co2Kg, 'kg CO2')}`,
    );
    lines.push(
      `  method ${footprint.method ?? 'unknown'} · dominant uncertainty: ${footprint.dominantUncertainty ?? 'not recorded'}`,
    );
  } else {
    lines.push('  footprint: not computed — the ledger holds no footprint estimate for the scope');
  }
  lines.push(
    `  grid: ${footprint.grid ?? 'not recorded by the ledger'} · infrastructure undisclosed for ${count(footprint.undisclosedProviders, 'provider', 'providers')}`,
  );
  return lines;
}

/**
 * The waste.
 *
 * The share is the waste tokens against the tokens of the scope, and the
 * kinds are the ledger's own names, so a reader can look the row up.
 */
function wasteLines(waste: WasteFacts): string[] {
  if (!waste.present || waste.byKind.length === 0) {
    return ['  no waste was recorded for the scope'];
  }
  const lines: string[] = [];
  lines.push(
    `  ${waste.percentage.toFixed(0)}% of tokens went to retries, undos and reverted code`,
  );
  lines.push(
    `  ${joined(waste.byKind.map((entry) => `${entry.kind} ${entry.percentage.toFixed(0)}%`))}`,
  );
  return lines;
}

/**
 * The value.
 *
 * The outcomes are the ledger's `outcome` table and the offload line is the
 * ledger's offload rows.
 */
function valueLines(value: ValueFacts): string[] {
  if (!value.present) {
    return ['  the scope holds no outcome'];
  }
  const lines: string[] = [];
  lines.push(
    `  ${count(value.tasksCompleted, 'task', 'tasks')} completed · ${count(value.tasksScrapped, 'scrapped task', 'scrapped tasks')}`,
  );
  if (value.tokensPerTask !== null) {
    lines.push(`  tokens per completed task: ${tokens(Math.round(value.tokensPerTask))}`);
  }
  if (value.offloadMessages > 0) {
    const saved =
      value.offloadSavedUsd === null
        ? 'the cloud price is unknown'
        : `~${money(value.offloadSavedUsd)} of cloud spend`;
    lines.push(`  offload saved ${tokens(value.offloadTokens)} tokens off the cloud (${saved})`);
  } else {
    lines.push('  offload: no work was offloaded');
  }
  return lines;
}

/**
 * The oversight.
 *
 * The counts are the board, the stores and the audit log. The two that no
 * package computes say so, with the reason, rather than showing a zero that
 * looks like a measurement.
 */
function oversightLines(oversight: OversightFacts): string[] {
  const lines: string[] = [];
  lines.push(
    `  ${count(oversight.lessons, 'lesson', 'lessons')} to review · ${count(oversight.memory, 'memory', 'memories')} to triage · ${count(oversight.waivers, 'waiver', 'waivers')} recorded`,
  );
  lines.push(
    `  ${count(oversight.records, 'board record', 'board records')} · audit log: ${count(oversight.auditEntries, 'entry', 'entries')} · open floor findings: ${oversight.openFloor}`,
  );
  lines.push(`  board/report mismatches: ${measured(oversight.mismatches)}`);
  lines.push(`  redactions: ${measured(oversight.redactions)}`);
  return lines;
}

/** A measured number, or the reason it is not known. */
function measured(value: Measured): string {
  return value.known ? String(value.value) : `not computed (${value.reason})`;
}

/**
 * The conformance.
 *
 * The counts are the conformance report of §11, and the unverified
 * capabilities are named, so nobody mistakes a guess about the host for a
 * tested fact.
 */
function conformanceLines(conformance: ConformanceFacts): string[] {
  const lines: string[] = [];
  lines.push(
    `  ${conformance.observed}/${conformance.total} observed · ${conformance.provenStatic} proven_static · ${conformance.unverified} unverified`,
  );
  if (conformance.pluginOrderWarnings.length === 0) {
    lines.push('  plugin-order warnings: none');
  } else {
    const names = conformance.pluginOrderWarnings.map((warning) => warning.plugin);
    lines.push(
      `  plugin-order warnings: ${count(names.length, 'warning', 'warnings')} (${joined(names)})`,
    );
  }
  lines.push(
    `  unverified: ${conformance.unverifiedIds.length === 0 ? 'none' : conformance.unverifiedIds.join(', ')}`,
  );
  return lines;
}

/**
 * The policies.
 *
 * The counts are the ledger's `policy_firing` table: the ten policies with
 * the most firings, the largest first, and the first-party policies that
 * never fired — a policy that never fires is dead code or a coverage gap,
 * and the report says which one it is.
 */
function policyLines(policies: PolicyFacts): string[] {
  if (!policies.present || policies.top.length === 0) {
    return ['  no policy fired for the scope'];
  }
  const lines: string[] = [];
  lines.push(`  ${count(policies.firings, 'firing', 'firings')}`);
  for (const policy of policies.top) {
    const versions = policy.versions.length === 0 ? '' : ` (${policy.versions.join(', ')})`;
    lines.push(
      `  ${policy.policyId} ${count(policy.count, 'firing', 'firings')}${versions} · ${policy.blocks} blocks · ${policy.flags} flags`,
    );
  }
  return lines;
}

/**
 * The report, as plain text.
 *
 * The text carries no colour and no escape, so it reads the same in a
 * terminal, in a pipe and in a ticket.
 */
export function renderEthicalReport(facts: ReportFacts): string {
  const lines: string[] = [];
  lines.push(`${TITLE} — ${scopeLabel(facts.scope)}`);
  lines.push('');
  lines.push('Cost and footprint');
  lines.push(...costLines(facts.cost, facts.footprint));
  lines.push('');
  lines.push('Waste');
  lines.push(...wasteLines(facts.waste));
  lines.push('');
  lines.push('Value');
  lines.push(...valueLines(facts.value));
  lines.push('');
  lines.push('Oversight');
  lines.push(...oversightLines(facts.oversight));
  lines.push('');
  lines.push('Conformance');
  lines.push(...conformanceLines(facts.conformance));
  lines.push('');
  lines.push('Policies');
  lines.push(...policyLines(facts.policies));
  if (facts.policies.neverFired.length > 0) {
    lines.push(`  never fired: ${facts.policies.neverFired.join(', ')}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The report, as JSON.
 *
 * The same facts, in the shape the JSON output carries. The numbers are the
 * numbers of the text: one report, two renderings, no second computation.
 */
export function ethicalReportJson(facts: ReportFacts): unknown {
  return {
    schema: 'openagentsy.ethical-report/v1',
    scope: facts.scope,
    cost: facts.cost,
    footprint: facts.footprint,
    waste: facts.waste,
    value: facts.value,
    oversight: facts.oversight,
    conformance: facts.conformance,
    policies: facts.policies,
  };
}
