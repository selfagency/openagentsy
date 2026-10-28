import type { Finding } from './rule.js';

/**
 * How many findings the agent is shown at once.
 *
 * The cap keeps a check from flooding the context of the session that wrote
 * the file. The full list is a tool call away, so nothing is lost by the
 * cap: the agent asks when the eight lines are not enough.
 */
export const MAX_REPORTED_FINDINGS = 8;

/**
 * The findings, one line each.
 *
 * A line names the rule, the place and the fix, so the agent can act on it
 * without asking what it means. The order of the lines is the order of the
 * findings, so the first line is the first thing to fix.
 */
export function formatFindings(findings: readonly Finding[]): string {
  return findings.map((f) => `${f.ruleId} ${f.file}:${f.line} — ${f.fix}`).join('\n');
}
