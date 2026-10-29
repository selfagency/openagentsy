import type { ReleaseCriterion, ReleaseReport, ReleaseVerdict } from './types.js';

/**
 * The report of a release check, as plain text.
 *
 * The text carries no colour and no table, so it reads in a terminal, in a
 * pipe and in a ticket. The failures and the unknowns come first, because
 * they are what a person has to do something about; the passes follow as a
 * list of ids, because a pass needs no reading.
 */

/**
 * The report, as it is read.
 */
export function formatReleaseReport(report: ReleaseReport): string {
  if (report.problem !== undefined) return `${report.problem}\n`;
  const lines: string[] = [];
  lines.push(`OpenAgentsy release check — ${report.packageName} ${report.version}`);
  lines.push(`  scope      ${scopeText(report)}`);
  lines.push(
    `  criteria   ${report.counts.total} total · ${report.counts.pass} pass · ${report.counts.fail} fail · ${report.counts.unknown} unknown · ${report.counts.notApplicable} not applicable`,
  );
  lines.push(
    `  answered   ${report.counts.machine} by a machine · ${report.counts.person} by a person · ${report.counts.both} by both`,
  );
  lines.push('');

  const failed = report.criteria.filter((criterion) => criterion.verdict === 'fail');
  const unknown = report.criteria.filter((criterion) => criterion.verdict === 'unknown');
  const passed = report.criteria.filter((criterion) => criterion.verdict === 'pass');

  for (const criterion of failed) lines.push(...criterionLines('fail', criterion));
  lines.push(...groupLines('unknown', unknown));

  if (failed.length === 0 && unknown.length === 0) {
    lines.push('  every criterion the framework states holds');
    lines.push('');
  }

  if (unknown.length > 0) {
    lines.push('  to answer a criterion:');
    lines.push(`    oa release-answer ${unknown[0]?.id ?? '<id>'} yes "why the release holds it"`);
    lines.push('');
  }

  if (passed.length > 0) {
    lines.push(`  pass  ${passed.map((criterion) => criterion.id).join(', ')}`);
    lines.push('');
  }

  if (report.unknownIds.length > 0) {
    lines.push(
      `  the framework carries ids the check does not know: ${report.unknownIds.join(', ')}`,
    );
    lines.push('');
  }

  lines.push(verdictText(report));
  return `${lines.join('\n')}\n`;
}

/** The scope, and what it means. */
function scopeText(report: ReleaseReport): string {
  if (report.severity === 'soft') {
    return 'library (soft): the findings are reported and the release is not blocked';
  }
  return 'first-party (hard): the release ships only when every criterion holds';
}

/** One criterion, and its reason. */
function criterionLines(verdict: ReleaseVerdict, criterion: ReleaseCriterion): string[] {
  const lines = [`  ${verdict.padEnd(8)} ${criterion.id.padEnd(28)} ${criterion.title}`];
  lines.push(`           ${criterion.reason}`);
  if (criterion.exception !== undefined) {
    lines.push(`           the documented exception: ${criterion.exception}`);
  }
  return lines;
}

/**
 * The criteria of one verdict, grouped by their reason.
 *
 * A report that prints one line per criterion is a report nobody reads when
 * forty criteria carry the same reason. The criteria that share a reason are
 * named together, and the ones that stand alone are named with their title.
 */
function groupLines(verdict: ReleaseVerdict, criteria: readonly ReleaseCriterion[]): string[] {
  const groups = new Map<string, ReleaseCriterion[]>();
  for (const criterion of criteria) {
    const key = criterion.reason;
    const group = groups.get(key) ?? [];
    group.push(criterion);
    groups.set(key, group);
  }
  const lines: string[] = [];
  for (const [reason, group] of groups) {
    if (group.length === 1) {
      const only = group[0];
      if (only !== undefined) lines.push(...criterionLines(verdict, only));
      continue;
    }
    lines.push(`  ${verdict.padEnd(8)} ${group.length} criteria: ${reason}`);
    lines.push(`           ${group.map((criterion) => criterion.id).join(', ')}`);
  }
  return lines;
}

/** The verdict of the release. */
function verdictText(report: ReleaseReport): string {
  const { fail, unknown } = report.counts;
  if (fail === 0 && unknown === 0) {
    return report.severity === 'soft'
      ? 'every criterion holds: the library release passes the check'
      : 'every criterion holds: the first-party release passes the check';
  }
  const parts: string[] = [];
  if (fail > 0) parts.push(`${fail} criteria failed`);
  if (unknown > 0) parts.push(`${unknown} criteria are unknown`);
  const detail = parts.join(' and ');
  if (report.severity === 'soft') {
    return `the check is soft here: ${detail}, and the release is not blocked`;
  }
  return `the release does not pass: ${detail}, and an unknown criterion is not a pass`;
}

/**
 * The report, as JSON.
 *
 * The same facts the text is rendered from, so the two cannot disagree.
 */
export function releaseCheckAsJson(report: ReleaseReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
