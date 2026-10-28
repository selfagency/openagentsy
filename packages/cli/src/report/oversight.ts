import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type BoardRecord,
  closeDatabase,
  listRecords,
  type OversightFacts,
  openDatabase,
  type ReportScope,
} from '@openagentsy/core';
import { createWaiverStore, listLessons, pendingLessons } from '@openagentsy/hooks';
import type { Finding, TaskFindings } from '@openagentsy/quality';

/**
 * The oversight of the scope.
 *
 * The counts are the board's records, the lessons that wait for a person,
 * the waivers a person recorded, the audit log and the findings store. The
 * two the plan names and no package keeps are carried as measurements that
 * are not known, with the reason: a zero there would look like a
 * measurement, and it is not one.
 */

/** How many records one page of the board holds. */
const PAGE_SIZE = 100;

/** The bean the archivist posts a candidate memory under. */
const MEMORY_BEAN = 'memory';

/** The states a decided candidate carries. */
const DECIDED_STATES = ['promoted', 'rejected'];

/**
 * Every record on the board.
 *
 * The board holds more than one page of records, and a report that read
 * only the first page would undercount a project with a long history. The
 * pages are walked until one comes back short.
 */
async function boardRecords(stateRoot: string): Promise<BoardRecord[]> {
  const path = join(stateRoot, '.openagentsy', 'board.sqlite');
  const exists = await access(path).then(
    () => true,
    () => false,
  );
  if (!exists) return [];

  const db = openDatabase(path);
  try {
    const found: BoardRecord[] = [];
    let cursor = 0;
    for (;;) {
      const page = listRecords(db, { cursor, limit: PAGE_SIZE });
      found.push(...page.records);
      if (page.records.length < PAGE_SIZE) return found;
      cursor = page.nextCursor;
    }
  } finally {
    closeDatabase(db);
  }
}

/**
 * The memory candidates waiting for a person.
 *
 * A candidate is a board record under the memory bean that no person has
 * decided on, and the decided states are the ones the memory package
 * writes: promoted and rejected. The rule is the memory package's, and the
 * report counts the records itself because the package sits above the
 * adapter and the report needs nothing else of it.
 */
function memoryCandidates(records: readonly BoardRecord[]): number {
  return records.filter(
    (record) => record.bean === MEMORY_BEAN && !DECIDED_STATES.includes(record.state),
  ).length;
}

/** The lines of the audit log. */
async function auditEntries(stateRoot: string): Promise<number> {
  const path = join(stateRoot, '.openagentsy', 'audit.jsonl');
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return 0;
  }
  return text.split('\n').filter((line) => line.trim() !== '').length;
}

/**
 * The findings of the scope.
 *
 * The findings are the store's, read through the quality package's read
 * path. A bean scope reads the findings of that task, because the ledger
 * reads the task of a bean the same way. Every other scope reads them all:
 * the findings store has no session and no window, and a report that
 * narrowed it by guesswork would be narrowing it wrongly.
 */
export function scopedFindings(findings: TaskFindings, scope: ReportScope): Finding[] {
  const scoped: Finding[] = [];
  for (const [taskId, entries] of Object.entries(findings)) {
    if (scope.kind === 'bean' && taskId !== scope.id) continue;
    scoped.push(...entries);
  }
  return scoped;
}

/**
 * The open floor findings of the scope.
 *
 * The floor tier is the one the gate refuses a ship over, so a report that
 * counts the open floor findings is counting the things that would stop the
 * work from shipping.
 */
function openFloor(
  findings: TaskFindings,
  scope: ReportScope,
): OversightFacts['openFloorFindings'] {
  const found: OversightFacts['openFloorFindings'] = [];
  for (const [taskId, entries] of Object.entries(findings)) {
    if (scope.kind === 'bean' && taskId !== scope.id) continue;
    for (const finding of entries) {
      if (finding.tier !== 'floor') continue;
      found.push({
        taskId,
        ruleId: finding.ruleId,
        file: finding.file,
        message: finding.message,
      });
    }
  }
  return found;
}

/**
 * The oversight of the scope.
 *
 * The board records of a bean scope are the records of that bean, and every
 * other scope sees the whole board: the board has no session column and no
 * window, so a report that narrowed it would be narrowing it by guesswork.
 */
export async function oversightFacts(
  stateRoot: string,
  scope: ReportScope,
  findings: TaskFindings,
): Promise<OversightFacts> {
  const records = await boardRecords(stateRoot);
  const scoped = scope.kind === 'bean' ? records.filter((r) => r.bean === scope.id) : records;
  const lessons = await listLessons(stateRoot);
  const waivers = await createWaiverStore(stateRoot).count();
  const floor = openFloor(findings, scope);

  return {
    records: scoped.length,
    lessons: pendingLessons(lessons).length,
    memory: memoryCandidates(records),
    waivers,
    auditEntries: await auditEntries(stateRoot),
    openFloor: floor.length,
    openFloorFindings: floor,
    mismatches: {
      known: false,
      reason: 'no package compares the board with a report',
    },
    redactions: {
      known: false,
      reason: 'no package keeps a counter',
    },
  };
}
