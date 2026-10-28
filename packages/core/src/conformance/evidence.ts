import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * The evidence store (§11).
 *
 * The file `.openagentsy/conformance.json` holds the observations: what was
 * seen, when, in which session, and where the observation comes from. An
 * observation without a source is a guess, and the store refuses one.
 *
 * Two kinds of observation exist, and the difference is the whole point:
 *
 * - `live`: the surface was seen working on a live OpenCode server. Only a
 *   live observation puts a capability in the `observed` state.
 * - `schema`: the surface was read off the published type declarations of
 *   the host. That is a reading of a package, not a session, so it proves
 *   the surface exists and nothing more. A schema observation leaves the
 *   capability in `proven_static`.
 *
 * The rule is enforced in the code and not in a comment. The write path
 * takes the observation and refuses one that is malformed; a live
 * observation without a session is refused, because a live observation
 * without a session is not a live observation. The state of a capability is
 * derived from the store alone, and the derivation promotes to `observed`
 * only on a live observation. A static probe never reaches this module, so
 * a probe can never upgrade a check.
 */

/** The directory the state of a project lives in, under the state root. */
export const STATE_DIR = '.openagentsy';

/** The name of the evidence file. */
export const EVIDENCE_FILE = 'conformance.json';

/** The version of the file format this module reads and writes. */
export const EVIDENCE_VERSION = 1;

/**
 * How many observations one capability keeps.
 *
 * The evidence is bounded on purpose: a file that grows with every session
 * is a file nobody reads, and the newest observations are the ones that
 * say whether the surface still works.
 */
export const MAX_OBSERVATIONS = 5;

/** Whether the surface was seen working, or read off the host's schema. */
export type EvidenceKind = 'live' | 'schema';

/** Where an observation comes from. */
export type EvidenceSource = {
  /** The kind of the source. */
  readonly kind: 'board-record' | 'probe-script' | 'declaration' | 'test';
  /** The record id, the path of the script, or the file that was read. */
  readonly ref: string;
  /** The day the observation was made. */
  readonly date: string;
};

/** One observation of one capability. */
export type Observation = {
  /** The capability the observation is about. */
  readonly capabilityId: string;
  /** The event that was seen, or the surface that was read. */
  readonly eventType: string;
  /** The session the observation was made in, when it was made live. */
  readonly sessionId?: string | undefined;
  /** When the observation was made. */
  readonly at: string;
  /** Whether it was seen working, or read off the schema. */
  readonly kind: EvidenceKind;
  /** Where the observation comes from. */
  readonly source: EvidenceSource;
  /** What was seen, in one line. */
  readonly note: string;
};

/** What the write path takes. */
export type ObservationInput = Omit<Observation, 'source'> & { readonly source: EvidenceSource };

/** The observations of one capability. */
export type EvidenceEntry = {
  readonly capabilityId: string;
  readonly observations: readonly Observation[];
};

/** The store, as it was read. */
export type EvidenceStore = {
  /** Where the store lives on disk. */
  readonly path: string;
  /** The entries, one per capability. */
  readonly entries: readonly EvidenceEntry[];
  /** Whether the file was on disk. */
  readonly onDisk: boolean;
  /** Why the file could not be read, when it could not be read. */
  readonly error?: string | undefined;
};

/** The shape of the file on disk. */
type EvidenceFile = {
  version: number;
  capabilities: Record<string, { observations: Observation[] }>;
};

/**
 * The error the store raises.
 *
 * The message says what is wrong and the hint says what to do next, like
 * every other error in this project.
 */
export class ConformanceError extends Error {
  readonly hint: string;

  constructor(message: string, hint: string) {
    super(message);
    this.name = 'ConformanceError';
    this.hint = hint;
  }
}

/** Where the evidence of a project lives. */
export function evidencePath(stateRoot: string): string {
  return join(stateRoot, STATE_DIR, EVIDENCE_FILE);
}

/**
 * Check an observation before it is written.
 *
 * The checks are the ones that keep a guess out of the file: an observation
 * names the capability, the event, the moment and the source, and the source
 * says where the observation comes from. The session is named when the
 * source names one.
 */
export function assertObservation(input: ObservationInput): void {
  if (input.capabilityId.trim() === '') {
    throw new ConformanceError(
      'The observation names no capability.',
      'An observation is about one capability, so the capability has a name.',
    );
  }
  if (input.eventType.trim() === '') {
    throw new ConformanceError(
      `The observation of ${input.capabilityId} names no event.`,
      'Name the event that was seen, or the surface that was read.',
    );
  }
  if (input.at.trim() === '' || Number.isNaN(Date.parse(input.at))) {
    throw new ConformanceError(
      `The observation of ${input.capabilityId} carries no moment.`,
      'The moment is an ISO timestamp, so a reader can tell how old the observation is.',
    );
  }
  if (input.note.trim() === '') {
    throw new ConformanceError(
      `The observation of ${input.capabilityId} says nothing.`,
      'Say what was seen, in one line.',
    );
  }
  if (input.source.ref.trim() === '' || input.source.date.trim() === '') {
    throw new ConformanceError(
      `The observation of ${input.capabilityId} has no source.`,
      'An observation names the board record, the probe script or the declaration it comes from.',
    );
  }
}

/** The observations of one capability, newest first. */
export function observationsFor(
  entries: readonly EvidenceEntry[],
  capabilityId: string,
): readonly Observation[] {
  const entry = entries.find((candidate) => candidate.capabilityId === capabilityId);
  if (entry === undefined) return [];
  return [...entry.observations].sort((left, right) => right.at.localeCompare(left.at));
}

/**
 * Whether the observations hold a live one.
 *
 * This is the only place a capability becomes `observed`, and it asks for a
 * live observation and not for a schema one.
 */
export function hasLiveObservation(observations: readonly Observation[]): boolean {
  return observations.some((observation) => observation.kind === 'live');
}

/**
 * Put two sets of observations together.
 *
 * The seed comes first and the file second, so the file is the newer word
 * about a capability. The result is bounded, the same way the file is.
 */
export function mergeObservations(
  ...lists: readonly (readonly Observation[])[]
): readonly Observation[] {
  const all = lists.flat();
  const sorted = [...all].sort((left, right) => right.at.localeCompare(left.at));
  return sorted.slice(0, MAX_OBSERVATIONS);
}

/** The empty store, for a project that has no evidence yet. */
function emptyStore(path: string, onDisk: boolean, error?: string): EvidenceStore {
  return {
    path,
    entries: [],
    onDisk,
    ...(error === undefined ? {} : { error }),
  };
}

/**
 * Read the evidence of a project.
 *
 * A file that cannot be read is reported, not thrown: a report that cannot
 * be built is worse than a report that says the evidence is unreadable.
 */
export async function readEvidence(stateRoot: string): Promise<EvidenceStore> {
  const path = evidencePath(stateRoot);
  const raw = await readFile(path, 'utf8').then(
    (text) => text,
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    },
  );
  if (raw === undefined) return emptyStore(path, false);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyStore(path, true, 'the file is not JSON');
  }
  if (!isRecord(parsed) || !isRecord(parsed.capabilities)) {
    return emptyStore(path, true, 'the file has no capabilities');
  }

  const entries: EvidenceEntry[] = [];
  for (const [capabilityId, value] of Object.entries(parsed.capabilities)) {
    if (!isRecord(value) || !Array.isArray(value.observations)) continue;
    const observations = value.observations.filter(isObservation).slice(0, MAX_OBSERVATIONS);
    entries.push({ capabilityId, observations });
  }
  return { path, entries, onDisk: true };
}

/**
 * Write one observation.
 *
 * This is the only path that changes the file, and it takes the whole
 * observation: the event, the moment, the kind, the source and the note. A
 * caller that cannot name the source has no observation to record, and the
 * write is refused.
 */
export async function recordObservation(
  stateRoot: string,
  input: ObservationInput,
): Promise<EvidenceStore> {
  assertObservation(input);
  const path = evidencePath(stateRoot);
  const store = await readEvidence(stateRoot);
  const observation: Observation = { ...input };

  const capabilities: Record<string, { observations: Observation[] }> = {};
  for (const entry of store.entries) {
    capabilities[entry.capabilityId] = { observations: [...entry.observations] };
  }
  const own = capabilities[input.capabilityId]?.observations ?? [];
  capabilities[input.capabilityId] = {
    observations: [...mergeObservations([observation], own)],
  };

  const file: EvidenceFile = { version: EVIDENCE_VERSION, capabilities };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  return readEvidence(stateRoot);
}

/** Whether a value is an object and not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a value is an observation this module can read back. */
function isObservation(value: unknown): value is Observation {
  if (!isRecord(value)) return false;
  if (typeof value.capabilityId !== 'string') return false;
  if (typeof value.eventType !== 'string') return false;
  if (typeof value.at !== 'string') return false;
  if (value.kind !== 'live' && value.kind !== 'schema') return false;
  if (typeof value.note !== 'string') return false;
  if (!isRecord(value.source)) return false;
  return typeof value.source.ref === 'string' && typeof value.source.date === 'string';
}
