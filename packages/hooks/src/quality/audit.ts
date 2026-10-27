import {
  allRegistry,
  check,
  type Finding,
  runSloplint,
  type SloplintDegradation,
  type SloplintPath,
} from '@openagentsy/quality';
import { readDesignMd } from './rule.js';
import { loadWaiverLookup, type WaiverLookup } from './waivers.js';

export type { Finding, SloplintDegradation, SloplintPath };

/**
 * The audit.
 *
 * The hook reports the findings of a write to the agent that made it, and
 * in the `after` mode the hook does nothing at all: the audit is the report
 * then. The audit runs the whole rule set over a scope of files, runs the
 * optional linter over the pages and the stylesheets in it, and marks the
 * findings a person waived.
 *
 * The whole rule set is the one the audit runs, the comment rules
 * included: the comment lint needs a TypeScript parse, and the audit is a
 * call a person made on purpose, so the parse is paid for on demand here
 * and not at all on the write path.
 *
 * The module is not exported from the package barrel: the whole rule set
 * carries the TypeScript compiler, and the plugin must not pay for it. The
 * callers reach it by its own path, `@openagentsy/hooks/quality/audit`.
 */

/** What the audit looks at. */
export interface QualityAuditOptions {
  /** The project root. The files are relative to it. */
  root: string;
  /** The files to audit. */
  files: readonly string[];
  /** The waivers that cover a finding. */
  waivers?: WaiverLookup | undefined;
}

/** What the audit found. */
export interface QualityAuditResult {
  /** The files the check read. */
  files: string[];
  /** Every finding, the waived ones included. */
  findings: Finding[];
  /** The findings no waiver covers. */
  open: Finding[];
  /** The findings a waiver covers. */
  waived: Finding[];
  /** Which path ran. */
  path: SloplintPath;
  /** Why the linter did not deliver, when it did not. */
  degraded?: SloplintDegradation | undefined;
  /** The script the linter ran, when one ran. */
  script?: string | undefined;
}

/**
 * The audit of a scope of files.
 *
 * The static findings stand in every case: a linter that is absent, that
 * crashes or that says something the bridge cannot read leaves the static
 * findings exactly as they were, and the report says which path ran.
 */
export async function runQualityAudit(options: QualityAuditOptions): Promise<QualityAuditResult> {
  const files = auditedFiles(options.files);
  const findings = await findingsOf(files, options.root);
  const linter = await runSloplint({ root: options.root, files });
  const all = [...findings, ...linter.findings];
  const waivers = options.waivers ?? (await loadWaiverLookup(options.root));
  const waived = all.filter((finding) => waivers.covers(finding));
  const open = all.filter((finding) => !waivers.covers(finding));
  return {
    files,
    findings: all,
    open,
    waived,
    path: linter.path,
    ...(linter.degraded !== undefined ? { degraded: linter.degraded } : {}),
    ...(linter.script !== undefined ? { script: linter.script } : {}),
  };
}

/**
 * The files a rule applies to.
 *
 * A file no rule reads is not read: the check reads every file it is given,
 * and a scope of a whole project holds a thousand files that no rule has an
 * opinion about.
 */
function auditedFiles(files: readonly string[]): string[] {
  return files.filter((path) => allRegistry.forFile(path).length > 0);
}

/**
 * The findings of the check, when there is a file to check.
 *
 * The design file is read as data: it can name a taste rule and turn it
 * off, and nothing else.
 */
async function findingsOf(files: readonly string[], root: string): Promise<Finding[]> {
  if (files.length === 0) return [];
  const design = await readDesignMd(root);
  const ctx = design === undefined ? {} : { design };
  return await check(files, ctx, { root, registry: allRegistry });
}
