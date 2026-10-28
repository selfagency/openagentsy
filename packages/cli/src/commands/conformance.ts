import type { ProjectRoots } from '@openagentsy/core';
import { buildConformanceReport, type ConformanceReport } from '@openagentsy/core';

/**
 * `oa conformance`: what is proven, observed or unverified (§11).
 *
 * The report says, per capability of the host, which of the three states it
 * is in, and it shows the evidence of an observed capability so a reader can
 * see where the observation came from. A capability with no observation and
 * no static proof is `unverified`, and the report says so rather than
 * leaving it out.
 *
 * The command never writes. The evidence of a project is written by the
 * session that observed it, and a report that wrote would be a report that
 * could make a capability observed without anything having been observed.
 */

/** The options the command takes. */
export type ConformanceOptions = {
  /** The moment the report is stamped with, when a caller holds one. */
  now?: string | undefined;
};

/** Build the report of a project. */
export async function runConformance(
  roots: ProjectRoots,
  options: ConformanceOptions = {},
): Promise<ConformanceReport> {
  return buildConformanceReport({
    workspace: roots.workspace,
    stateRoot: roots.stateRoot,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

/** The state of a capability, as it is printed. */
function stateOf(entry: ConformanceReport['capabilities'][number]): string {
  return entry.state;
}

/**
 * The report, as plain text.
 *
 * One block per capability, the state first, and the evidence under it when
 * there is one. The lines are plain text with no colour, so the report can
 * be read in a pipe, in a terminal and in a ticket.
 */
export function formatConformanceReport(report: ConformanceReport): string {
  const lines: string[] = [];
  lines.push(`OpenAgentsy conformance — ${report.counts.total} capabilities, host v2`);
  lines.push(
    `  observed ${report.counts.observed} · proven_static ${report.counts.proven_static} · unverified ${report.counts.unverified}`,
  );
  lines.push('');

  for (const entry of report.capabilities) {
    const reference = entry.verifyRef === undefined ? '' : `  ${entry.verifyRef}`;
    lines.push(`  ${entry.id.padEnd(26)}${stateOf(entry).padEnd(15)}${reference}`);
    lines.push(`      ${entry.title}`);
    if (entry.evidence.length === 0) {
      lines.push('      no observation');
      continue;
    }
    for (const observation of entry.evidence) {
      const source = `${observation.source.kind} ${observation.source.ref}`;
      lines.push(
        `      ${observation.eventType} ${observation.at}  ${observation.kind}  ${source}`,
      );
      lines.push(`        ${observation.note}`);
    }
  }

  lines.push('');
  if (report.pluginOrderWarnings.length === 0) {
    lines.push('  plugin-order warnings: 0');
  } else {
    lines.push(`  plugin-order warnings: ${report.pluginOrderWarnings.length}`);
    for (const warning of report.pluginOrderWarnings) {
      lines.push(`    ${warning.plugin}: ${warning.detail}`);
    }
  }
  lines.push(
    `  evidence: ${report.evidencePath}${report.evidenceOnDisk ? '' : ' (the file is not on disk; the seed is in the report)'}`,
  );
  lines.push(
    `  void capabilities: ${report.voided.length} (the V1 entries of the plan; the project speaks OpenCode 2 only)`,
  );
  if (report.evidenceError !== undefined) {
    lines.push(`  the evidence file could not be read: ${report.evidenceError}`);
  }
  return `${lines.join('\n')}\n`;
}
