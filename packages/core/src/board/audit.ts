import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export type AuditEffect = 'allow' | 'ask' | 'deny';

export type AuditEntry = {
  ts: string;
  policyId: string;
  policyVersion: string;
  actor: string;
  action: string;
  resource: string;
  effect: AuditEffect;
  detail?: string;
};

export type AuditInput = Omit<AuditEntry, 'ts'>;

/**
 * The policy registry. Every decision the board makes carries one of these
 * ids so an audit line can be traced back to the rule that produced it.
 */
export const POLICIES = {
  recordPost: { id: 'oa.record.post', version: 'v1' },
  recordIdentity: { id: 'oa.record.identity', version: 'v1' },
  leaseGrant: { id: 'oa.lease.grant', version: 'v1' },
  leaseRelease: { id: 'oa.lease.release', version: 'v1' },
  leaseRevoke: { id: 'oa.lease.revoke', version: 'v1' },
  leaseDeny: { id: 'oa.lease.deny', version: 'v1' },
  budgetSet: { id: 'oa.budget.set', version: 'v1' },
  budgetStop: { id: 'oa.budget.stop', version: 'v1' },
  budgetUsage: { id: 'oa.budget.usage', version: 'v1' },
  budgetWarn: { id: 'oa.budget.warn', version: 'v1' },
} as const;

export async function appendAudit(path: string, entry: AuditInput): Promise<void> {
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, line, 'utf8');
}

/**
 * The size at which the audit log is rotated.
 *
 * A decision line is roughly 250 bytes, so half a megabyte holds around two
 * thousand decisions, which covers many sessions of one project. The cap is
 * small enough that reading the live log stays cheap and the whole audit
 * history stays bounded at roughly three megabytes with the archives below.
 */
export const AUDIT_MAX_BYTES = 512 * 1024;

/**
 * How many numbered archives are kept beside the live log.
 *
 * Five archives at the cap keep the recent history bounded while leaving
 * enough of it to trace a decision from a previous session. The oldest is
 * dropped on the next rotation; the drop is reported, never silent.
 */
export const AUDIT_ROTATIONS = 5;

export type AuditRotation = {
  /** Whether the log was over the cap and was rotated. */
  rotated: boolean;
  /** The lines moved out of the live log. */
  movedLines: number;
  /** Their size, in bytes. */
  movedBytes: number;
  /** The archive that received them, when the rotation happened. */
  archive?: string;
  /** The archive dropped to make room, when there was one. */
  dropped?: string;
  /** Why the rotation did not happen, when it failed. Never thrown. */
  error?: string;
};

/** `audit.jsonl` -> `audit.1.jsonl`, `audit.2.jsonl`, ... beside it. */
function archivePath(path: string, number: number): string {
  const name = basename(path);
  const stem = name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : name;
  return join(dirname(path), `${stem}.${number}.jsonl`);
}

/**
 * Where the live log ends and the archive begins, measured from the newest
 * line so the newest lines stay in the live log.
 *
 * Returns `undefined` when the newest line alone is larger than the cap: a
 * single line larger than the cap is kept in the live log, the newest entry
 * is never lost, and there is nothing older to archive.
 */
function measureTail(lines: string[], maxBytes: number): number | undefined {
  let tailBytes = 0;
  let cut = lines.length;
  while (cut > 0) {
    const size = Buffer.byteLength(lines[cut - 1] ?? '');
    if (tailBytes + size > maxBytes && cut < lines.length) break;
    tailBytes += size;
    cut -= 1;
  }
  return cut === 0 ? undefined : cut;
}

/**
 * Make room for the new archive at slot one, and return the archive dropped
 * to make it, when the history was long enough to have one.
 *
 * The archives are dropped from the oldest end, so a failure in the
 * renumbering below leaves the live log untouched instead of losing lines it
 * still holds.
 */
async function makeRoomForArchive(path: string, keep: number): Promise<string | undefined> {
  const droppedPath = archivePath(path, keep);
  let dropped: string | undefined;
  try {
    await stat(droppedPath);
    await rm(droppedPath, { force: true });
    dropped = droppedPath;
  } catch {
    // Nothing was there to drop: the history is not that long yet.
    dropped = undefined;
  }
  for (let number = keep - 1; number >= 1; number -= 1) {
    try {
      await rename(archivePath(path, number), archivePath(path, number + 1));
    } catch {
      // No archive at this slot yet: the next one starts a new history.
    }
  }
  return dropped;
}

/**
 * Rotate the audit log when it grows past the cap.
 *
 * The newest lines stay in the live log, so a reader of `audit.jsonl` loses
 * nothing it was looking at. The older lines move into the numbered archive
 * beside it. Only the live log and those archives are touched: never the
 * board database, never the records, never the leases, and nothing outside
 * `.openagentsy`. A path that is not an audit log this function was handed is
 * the caller's file.
 *
 * The rotation never throws: a caller appending a decision must not fail
 * because the log could not be rotated, and the server that runs it in the
 * background must not be taken down by it. The returned record names what
 * moved and what was dropped, so the eviction is not silent.
 */
export async function rotateAudit(
  path: string,
  options: { maxBytes?: number; keep?: number } = {},
): Promise<AuditRotation> {
  const maxBytes = options.maxBytes ?? AUDIT_MAX_BYTES;
  const keep = options.keep ?? AUDIT_ROTATIONS;
  const idle: AuditRotation = { rotated: false, movedLines: 0, movedBytes: 0 };

  try {
    // A board that has never appended a decision has no log, and that is not
    // a rotation failure: there is nothing to move.
    const info = await stat(path).catch(() => undefined);
    if (info === undefined) return idle;
    if (info.size <= maxBytes) return idle;

    const content = await readFile(path, 'utf8');
    // Each line keeps its newline, so the tail is written back byte for byte.
    const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const cut = measureTail(lines, maxBytes);
    // A single line larger than the cap is kept in the live log: there is
    // nothing older to archive.
    if (cut === undefined) return idle;

    const older = lines.slice(0, cut).join('');
    const recent = lines.slice(cut).join('');
    const movedBytes = Buffer.byteLength(older);

    const dropped = await makeRoomForArchive(path, keep);

    const archive = archivePath(path, 1);
    await writeFile(archive, older, 'utf8');
    await writeFile(path, recent, 'utf8');

    return {
      rotated: true,
      movedLines: cut,
      movedBytes,
      archive,
      ...(dropped === undefined ? {} : { dropped }),
    };
  } catch (error) {
    return { ...idle, error: error instanceof Error ? error.message : String(error) };
  }
}
