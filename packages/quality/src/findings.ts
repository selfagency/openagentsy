import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Finding } from './rule.js';

/**
 * The read path of the findings store.
 *
 * The store that writes the findings lives in the hooks package, and the
 * hooks package sits above this one, so this package cannot import it. What
 * it can do is read the file the store writes, and that file is the truth:
 * a finding that was fixed goes away when the file is written again.
 *
 * A report that needs the findings of a project asks here, and a gate that
 * needs them asks here too: the writer keeps its own path and this reader
 * keeps the other end of the same file.
 */

/** The state directory the findings live under. */
const STATE_DIR = '.openagentsy';

/** The directory of the quality state inside it. */
const QUALITY_DIR = 'quality';

/** The file the findings live in. */
const FINDINGS_FILE = 'findings.json';

/** The path the findings live at, under a state root. */
export function findingsFile(stateRoot: string): string {
  return join(stateRoot, STATE_DIR, QUALITY_DIR, FINDINGS_FILE);
}

/** A finding, as the file holds it. */
const FindingSchema = z.object({
  ruleId: z.string(),
  source: z.string(),
  tier: z.enum(['floor', 'reflex', 'finish']),
  file: z.string(),
  line: z.number(),
  message: z.string(),
  fix: z.string(),
  kind: z.enum(['claim']).optional(),
});

/** The file, as it holds the findings. */
const FindingsFileSchema = z.object({
  version: z.number(),
  tasks: z.record(z.string(), z.array(FindingSchema)),
});

/** The findings of every task, keyed by the task they belong to. */
export type TaskFindings = Record<string, Finding[]>;

/** A finding, and the task it belongs to. */
export type TaskFinding = {
  /** The task the finding was recorded for. */
  taskId: string;
  /** The finding itself. */
  finding: Finding;
};

/**
 * The findings of every task.
 *
 * A project with no findings file holds no findings, and that is an empty
 * map and not a failure. A file that cannot be read or cannot be parsed is
 * read as empty for the same reason: a report that cannot see the findings
 * says so through the numbers it prints, and a report that throws is a
 * report nobody runs.
 */
export async function readFindings(stateRoot: string): Promise<TaskFindings> {
  let text: string;
  try {
    text = await readFile(findingsFile(stateRoot), 'utf8');
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  const result = FindingsFileSchema.safeParse(parsed);
  if (!result.success) return {};
  const tasks: TaskFindings = {};
  for (const [taskId, entries] of Object.entries(result.data.tasks)) {
    tasks[taskId] = entries.map((entry) => {
      const base = {
        ruleId: entry.ruleId,
        source: entry.source,
        tier: entry.tier,
        file: entry.file,
        line: entry.line,
        message: entry.message,
        fix: entry.fix,
      };
      return entry.kind === undefined ? base : { ...base, kind: entry.kind };
    });
  }
  return tasks;
}

/**
 * The floor findings that are open, and the tasks they belong to.
 *
 * The floor tier is the one the gate refuses a ship over, so a report that
 * counts the open floor findings is counting the things that would stop the
 * work from shipping.
 */
export async function readOpenFloor(stateRoot: string): Promise<TaskFinding[]> {
  const tasks = await readFindings(stateRoot);
  const found: TaskFinding[] = [];
  for (const [taskId, entries] of Object.entries(tasks)) {
    for (const finding of entries) {
      if (finding.tier !== 'floor') continue;
      found.push({ taskId, finding });
    }
  }
  return found;
}
