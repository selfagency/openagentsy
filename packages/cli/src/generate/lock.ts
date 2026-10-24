import { type ModelLock, type ModelLockEntry, readLock } from '@openagentsy/models';

export type { ModelLock, ModelLockEntry };

/**
 * The lock file is written by `openagentsy models init`. It is optional: a
 * project without one still gets valid agent files, they just inherit the
 * OpenCode default model.
 *
 * The type and the reader come from the package that owns the lock, so the
 * CLI and the model selector cannot drift apart.
 */
export async function readModelLock(path: string): Promise<ModelLock | undefined> {
  return readLock(path);
}

export function lockEntryFor(
  lock: ModelLock | undefined,
  role: string,
): ModelLockEntry | undefined {
  return lock?.roles[role];
}

/** The effort levels the lock says this role runs at. */
export function lockVariants(entry: ModelLockEntry | undefined): {
  start?: string;
  ceiling?: string;
} {
  const ladder = entry?.ladder ?? [];
  const first = ladder[0];
  const last = ladder[ladder.length - 1];
  return {
    ...(first?.variant !== undefined ? { start: first.variant } : {}),
    ...(last?.variant !== undefined ? { ceiling: last.variant } : {}),
  };
}
