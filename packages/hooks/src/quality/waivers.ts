import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { normalizePath } from '@openagentsy/core';
import type { Finding } from '@openagentsy/quality/rule';
import { z } from 'zod';

/**
 * The waivers.
 *
 * A waiver is a decision a person makes: this rule is not a problem in this
 * file, and here is why. An agent may propose one in chat; only a person
 * records one, with the command. So the file holds the decisions of people,
 * and the rule asks the store whether a finding is covered before it calls
 * that finding open.
 *
 * The file lives under the state root, beside the findings, and it is the
 * only truth: the rule reads it after a write, and the write of a waiver is
 * the write of a person and not of a session.
 */

/** A waiver, as the file holds it. */
export const WaiverSchema = z.object({
  ruleId: z.string(),
  path: z.string(),
  reason: z.string().min(10),
  decidedBy: z.string(),
  ts: z.string(),
});

/** A waiver. */
export type Waiver = z.infer<typeof WaiverSchema>;

/** The file the waivers live in. */
export function waiversPath(stateRoot: string): string {
  return join(stateRoot, '.openagentsy', 'quality', 'waivers.json');
}

/** The file, as it holds the waivers. */
const WaiversFileSchema = z.object({
  version: z.number(),
  waivers: z.array(WaiverSchema),
});

/** What the file holds. */
type WaiversFile = z.infer<typeof WaiversFileSchema>;

/** What the store can do. */
export interface WaiverStore {
  /** Every waiver. */
  all(): Promise<Waiver[]>;
  /** Record a waiver. */
  add(waiver: Waiver): Promise<void>;
  /** How many waivers there are. */
  count(): Promise<number>;
}

/**
 * The store of a project.
 *
 * The state root is the root of the project, so two projects never read
 * each other's waivers.
 */
export function createWaiverStore(stateRoot: string): WaiverStore {
  const path = waiversPath(stateRoot);
  return {
    all: async () => (await readState(path)).waivers,
    add: async (waiver) => {
      const state = await readState(path);
      await writeState(path, { version: state.version, waivers: [...state.waivers, waiver] });
    },
    count: async () => (await readState(path)).waivers.length,
  };
}

/** The state of a project that has no waivers yet. */
function emptyState(): WaiversFile {
  return { version: 1, waivers: [] };
}

/**
 * What the file holds, when it holds something a store can read.
 *
 * A file that cannot be read, or that does not fit the schema, holds
 * nothing: a broken file of decisions must not fail the write that asked
 * about them.
 */
async function readState(path: string): Promise<WaiversFile> {
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
  const result = WaiversFileSchema.safeParse(parsed);
  if (!result.success) return emptyState();
  return result.data;
}

/**
 * Write the state.
 *
 * The write goes to a temporary file that is renamed over the old one, so a
 * reader never sees half a file: the rule reads this file while the person
 * writes it.
 */
async function writeState(path: string, state: WaiversFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

/**
 * The lookup the rule asks.
 *
 * The rule holds the seam, and this is what fills it: a finding that a
 * waiver covers is not open.
 */
export interface WaiverLookup {
  /** Whether a waiver covers a finding. */
  covers(finding: Finding): boolean;
}

/** The lookup that covers nothing. */
export const noWaivers: WaiverLookup = { covers: () => false };

/**
 * The lookup of the waivers on disk.
 *
 * The waivers are read once, and the lookup answers from what it read: the
 * rule asks on every write, and a write may not wait for a file.
 */
export async function loadWaiverLookup(stateRoot: string): Promise<WaiverLookup> {
  const waivers = await createWaiverStore(stateRoot).all();
  return { covers: (finding) => coversFinding(stateRoot, waivers, finding) };
}

/**
 * Whether one of the waivers covers a finding.
 *
 * A waiver names a rule and a path, and it covers the findings of that rule
 * in that file and in no other.
 */
function coversFinding(root: string, waivers: readonly Waiver[], finding: Finding): boolean {
  const file = relativeTo(root, finding.file);
  return waivers.some(
    (waiver) => waiver.ruleId === finding.ruleId && relativeTo(root, waiver.path) === file,
  );
}

/**
 * A path relative to the root, when the path is inside it.
 *
 * A finding carries the path the agent knows, and that path is sometimes
 * absolute and sometimes relative. A waiver carries the path a person
 * typed. Both are brought to the same form before they are compared.
 */
function relativeTo(root: string, path: string): string {
  const normalized = normalizePath(path);
  const base = normalizePath(root);
  if (!normalized.startsWith(`${base}/`)) return normalized;
  return normalized.slice(base.length + 1);
}
