import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRoles, type RolesFile } from '@openagentsy/core';
import type { BoardReader, BoardRecord } from './inbox.js';

/**
 * The fakes the tests share.
 *
 * A board reader that holds its records in memory, a state root in a
 * temporary directory, and the real roles file of the repository. The
 * package never imports the board server, so this is how a test stands in
 * for it.
 */

/** The root of the repository the tests run in. */
export const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));

/** A state root in a temporary directory, and the way to remove it. */
export async function temporaryRoot(): Promise<{ root: string; remove: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'openagentsy-memory-'));
  return { root, remove: () => rm(root, { recursive: true, force: true }) };
}

/** A candidate as the archivist posts it. */
export function candidateRecord(overrides: Partial<BoardRecord> = {}): BoardRecord {
  return {
    id: 1,
    bean: 'memory',
    kind: 'finding',
    from: 'oa-archivist',
    to: 'agentsy',
    action: 'The lease guard refuses a write to a file no lease covers.',
    state: 'build · 2a-1',
    confidence: 'inferred',
    ...overrides,
  };
}

/**
 * A reader that holds its records in memory.
 *
 * The records are the same objects every time, so a decision that marks one
 * is visible to the next read, the way a board that has been written to
 * would be.
 */
export function fakeReader(records: BoardRecord[]): BoardReader {
  return async () => records;
}

/** The real roles file of the repository. */
export async function loadRealRoles(): Promise<RolesFile> {
  return loadRoles(join(repositoryRoot, 'roles.yaml'));
}
