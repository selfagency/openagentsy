import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
// The narrow paths are the point. The barrel of the quality package carries
// the comment rules, and the comment rules carry the TypeScript compiler.
import { check } from '@openagentsy/quality/check';
import { compilerFreeRegistry } from '@openagentsy/quality/compiler-free';
import { formatFindings, MAX_REPORTED_FINDINGS } from '@openagentsy/quality/report';
import type { Finding } from '@openagentsy/quality/rule';
import { type FileRef, readPreToolCall } from '../event.js';
import type { HandlerResult, Rule } from '../registry.js';
import { createFindingsStore, type FindingsStore } from './findings.js';
import { loadWaiverLookup, type WaiverLookup } from './waivers.js';

/**
 * The quality check, run after a write.
 *
 * The rule runs the static rules on the files a call touched, records what
 * it found, and tells the agent what to fix. It never stops the call: the
 * plan's blocking is on the task, not on the write, and a write that has
 * already happened cannot be stopped anyway. What it says is capped, so a
 * check cannot flood the context of the session that wrote the file.
 *
 * The rules it runs are the ones that need no compiler. The comment rules
 * need a TypeScript parse to find the comments of a file, and this rule
 * runs on every write, so the plugin would carry the compiler and pay for
 * a parse per write. The comment lint still runs in the `oa_quality_check`
 * tool and in the audit command, where a parse is paid for on demand.
 */

/** The answer of a rule that lets the call through. */
const CONTINUE: HandlerResult = { continue: true };

/** When the check runs. */
export type QualityMode = 'during' | 'after';

/** What the rule needs to know. */
export interface QualityRuleOptions {
  /** The project the agent works in. */
  workspace: string;
  /** Where the `.openagentsy/` directory lives. */
  stateRoot: string;
  /** When the check runs. */
  mode: QualityMode;
  /** The task the findings belong to, when there is one. */
  taskId?: string | undefined;
  /** The task of a session, when the session has one. */
  taskIdForSession?: (sessionID: string) => string | undefined | Promise<string | undefined>;
  /** The design file, read as data. */
  design?: string | undefined;
  /** The waivers that cover a finding. */
  waivers?: WaiverLookup;
  /** The store the findings go into. */
  store?: FindingsStore;
  /** How the check runs. */
  check?: typeof check;
}

/**
 * The rule.
 *
 * The mode decides what the rule does: `during` runs the check after every
 * write, and `after` does nothing here — the findings are reported by the
 * audit command instead.
 */
export function qualityAfterWrite(options: QualityRuleOptions): Rule {
  const store = options.store ?? createFindingsStore(options.stateRoot);
  const run = options.check ?? check;
  return {
    id: 'quality-after-write',
    event: 'PostToolCall',
    block: false,
    handler: async (event) => {
      if (options.mode !== 'during') return CONTINUE;
      const call = readPreToolCall(event);
      if (call === undefined) return CONTINUE;
      const paths = writtenPaths(call.files);
      if (paths.length === 0) return CONTINUE;
      const findings = await findingsOf(run, paths, options);
      if (findings === undefined) return CONTINUE;
      await recordOf(store, options, call.sessionID, paths, findings);
      const open = await openFindings(findings, options);
      if (open.length === 0) return CONTINUE;
      return {
        transform: {
          appendToResult: formatFindings(open.slice(0, MAX_REPORTED_FINDINGS)),
        },
      };
    },
  };
}

/**
 * The paths a call wrote.
 *
 * A file that was deleted is in the list as well: there is nothing to read
 * of it, and the findings it had are moot, so the store drops them.
 */
function writtenPaths(files: readonly FileRef[]): string[] {
  const paths: string[] = [];
  for (const file of files) {
    if (file.path === undefined || file.path === '') continue;
    if (!paths.includes(file.path)) paths.push(file.path);
  }
  return paths;
}

/**
 * The findings of the check, when the check ran.
 *
 * A rule that throws is a bug in the rule, and the rules have their own
 * tests. The write has already happened, so a broken check must not turn it
 * into an error: the failure is dropped and the agent sees nothing.
 */
async function findingsOf(
  run: typeof check,
  paths: readonly string[],
  options: QualityRuleOptions,
): Promise<Finding[] | undefined> {
  try {
    const design = options.design ?? (await readDesignMd(options.workspace));
    const ctx = design === undefined ? {} : { design };
    return await run(paths, ctx, { root: options.workspace, registry: compilerFreeRegistry });
  } catch {
    return undefined;
  }
}

/**
 * The findings that are open: not taste, and not waived.
 *
 * The waivers are read when there is something to filter: a call that found
 * nothing does not read the decisions of the project. A waiver a person
 * recorded covers a finding, and a covered finding is not open.
 */
async function openFindings(
  findings: readonly Finding[],
  options: QualityRuleOptions,
): Promise<Finding[]> {
  if (findings.length === 0) return [];
  const waivers = options.waivers ?? (await loadWaiverLookup(options.stateRoot));
  return findings.filter((finding) => finding.tier !== 'finish' && !waivers.covers(finding));
}

/**
 * Record the findings, when there is a task to record them for.
 *
 * A session with no task records nothing: there is no task to complete, so
 * there is nothing for the findings to stop. An unwritable state root must
 * not fail the write either.
 */
async function recordOf(
  store: FindingsStore,
  options: QualityRuleOptions,
  sessionID: string | undefined,
  paths: readonly string[],
  findings: readonly Finding[],
): Promise<boolean> {
  const taskId = await taskIdOf(options, sessionID);
  if (taskId === undefined) return false;
  try {
    await store.record(taskId, paths, findings);
    return true;
  } catch {
    return false;
  }
}

/** The task of a session, when there is one. */
async function taskIdOf(
  options: QualityRuleOptions,
  sessionID: string | undefined,
): Promise<string | undefined> {
  if (options.taskId !== undefined) return options.taskId;
  if (options.taskIdForSession === undefined || sessionID === undefined) return undefined;
  return await options.taskIdForSession(sessionID);
}

/**
 * The design file of a project, read as data.
 *
 * The file is optional, and it is never read as instructions: it can name
 * a taste rule and turn it off, and nothing else.
 */
export async function readDesignMd(workspace: string): Promise<string | undefined> {
  for (const name of ['DESIGN.md', 'design.md']) {
    const text = await readDesign(join(workspace, name));
    if (text !== undefined) return text;
  }
  return undefined;
}

/** The text of a file, when it can be read. */
async function readDesign(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}
