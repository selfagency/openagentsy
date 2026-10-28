import { join } from 'node:path';
import {
  closeDatabase,
  isRoundStatus,
  listRecords,
  openDatabase,
  type RoundStatus,
} from '@openagentsy/core';

/**
 * The status the board holds.
 *
 * The board has no table of round statuses, so the status a round was
 * persisted with is the one a record carries: the Lead writes the state of
 * its round down before it reports it. A board that holds no such record
 * holds no status, and the observer finds nothing to contradict.
 *
 * Both paths read it: the V1 path reads the board through the server
 * client, and the V2 path reads the same file, because the board is one
 * file and the runtime does not change where it lives.
 *
 * The board is the state root's, so a session in a worktree reads the
 * status of the round the Lead persisted on the main board.
 */
export function boardRoundStatus(stateRoot: string): RoundStatus | undefined {
  const db = openDatabase(join(stateRoot, '.openagentsy', 'board.sqlite'));
  try {
    const { records } = listRecords(db, { limit: 100, markRead: false });
    for (const record of [...records].reverse()) {
      if (isRoundStatus(record.state)) return record.state;
    }
    return undefined;
  } finally {
    closeDatabase(db);
  }
}
