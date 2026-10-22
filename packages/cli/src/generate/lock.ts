import { readFile } from "node:fs/promises"

export type ModelLockEntry = {
  model: string
  runnerUp?: string
  evidence?: {
    source: string
    label?: string
    date?: string
  }
  date?: string
  ladder: { model: string; variant?: string }[]
}

export type ModelLock = {
  generatedAt: string
  roles: Record<string, ModelLockEntry>
}

/**
 * The lock file is written by `openagentsy models init`. It is optional: a
 * project without one still gets valid agent files, they just inherit the
 * OpenCode default model.
 */
export async function readModelLock(path: string): Promise<ModelLock | undefined> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== "object" || parsed === null) return undefined
    return parsed as ModelLock
  } catch {
    return undefined
  }
}

export function lockEntryFor(lock: ModelLock | undefined, role: string): ModelLockEntry | undefined {
  return lock?.roles[role]
}

/** The effort levels the lock says this role runs at. */
export function lockVariants(
  entry: ModelLockEntry | undefined,
): { start?: string; ceiling?: string } {
  const ladder = entry?.ladder ?? []
  const first = ladder[0]
  const last = ladder[ladder.length - 1]
  return {
    ...(first?.variant !== undefined ? { start: first.variant } : {}),
    ...(last?.variant !== undefined ? { ceiling: last.variant } : {}),
  }
}
