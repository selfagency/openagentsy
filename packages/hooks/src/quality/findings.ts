import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { normalizePath } from '@openagentsy/core';
import type { Finding } from '@openagentsy/quality';
import { z } from 'zod';

/**
 * The findings store.
 *
 * The findings a check produced have to outlive the session that produced
 * them: the task store reads them when a task is completed, and that is
 * another process, hours later. So they live in a file under the state
 * root, beside the waivers the next bean writes, and the file is the only
 * truth.
 *
 * A record replaces the findings of the files it checked and keeps the
 * findings of the other files. So a finding that has been fixed goes away
 * when the file is written again, and a finding of another file is not
 * lost by the write.
 */

/** The file the findings live in. */
export function findingsPath(stateRoot: string): string {
  return join(stateRoot, '.openagentsy', 'quality', 'findings.json');
}

/** What the store can do. */
export interface FindingsStore {
  /** Record what a check found, for the files the check looked at. */
  record(taskId: string, files: readonly string[], findings: readonly Finding[]): Promise<void>;
  /** Every finding recorded for a task. */
  forTask(taskId: string): Promise<Finding[]>;
  /** The floor findings that are open for a task. */
  openFloor(taskId: string): Promise<Finding[]>;
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

/** What the file holds. */
type FindingsFile = z.infer<typeof FindingsFileSchema>;

/** The findings of a task, as the quality package says a finding is. */
type TaskFindings = Record<string, Finding[]>;

/**
 * A finding, as the quality package says it.
 *
 * The schema knows an absent kind and an undefined kind alike, and the
 * package says the kind is there or not there, so the absent one is
 * dropped on the way out.
 */
function toFinding(entry: z.infer<typeof FindingSchema>): Finding {
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
}

/** The state of a project that has no findings yet. */
function emptyState(): TaskFindings {
  return {};
}

/**
 * The store of a project.
 *
 * The state root is the root of the project, and the file is under it, so
 * two projects never read each other's findings.
 */
export function createFindingsStore(stateRoot: string): FindingsStore {
  const path = findingsPath(stateRoot);
  return {
    record: async (taskId, files, findings) => {
      const state = await readState(path);
      const checked = new Set(files.map((file) => normalizePath(file)));
      const kept = (state[taskId] ?? []).filter(
        (finding) => !checked.has(normalizePath(finding.file)),
      );
      state[taskId] = [...kept, ...findings];
      await writeState(path, state);
    },
    forTask: async (taskId) => (await readState(path))[taskId] ?? [],
    openFloor: async (taskId) =>
      ((await readState(path))[taskId] ?? []).filter((finding) => finding.tier === 'floor'),
  };
}

/** What the file holds, when it holds something a store can read. */
async function readState(path: string): Promise<TaskFindings> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return emptyState();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyState();
  }
  const result = FindingsFileSchema.safeParse(parsed);
  if (!result.success) return emptyState();
  const tasks: TaskFindings = {};
  for (const [taskId, entries] of Object.entries(result.data.tasks)) {
    tasks[taskId] = entries.map(toFinding);
  }
  return tasks;
}

/**
 * Write the state.
 *
 * The write goes to a temporary file that is renamed over the old one, so
 * a reader never sees half a file: the task store reads this file while
 * the plugin writes it.
 */
async function writeState(path: string, state: TaskFindings): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  const file: FindingsFile = { version: 1, tasks: state };
  await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}
