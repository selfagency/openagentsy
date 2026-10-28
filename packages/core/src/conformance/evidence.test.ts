import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertObservation,
  ConformanceError,
  evidencePath,
  hasLiveObservation,
  MAX_OBSERVATIONS,
  mergeObservations,
  type Observation,
  type ObservationInput,
  readEvidence,
  recordObservation,
} from './evidence.js';

let root: string;

/** An observation that holds every field. */
function observation(overrides: Partial<ObservationInput> = {}): ObservationInput {
  return {
    capabilityId: 'session-family',
    eventType: 'session.family.read',
    at: '2026-10-28T04:51:23.320Z',
    kind: 'live',
    source: { kind: 'board-record', ref: '706', date: '2026-10-28' },
    note: 'the family of a session is a list of ids',
    ...overrides,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openagentsy-evidence-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('the evidence store', () => {
  it('puts the evidence of a project under its state root', () => {
    expect(evidencePath(root)).toBe(join(root, '.openagentsy', 'conformance.json'));
  });

  it('has no evidence in a project that has none', async () => {
    const store = await readEvidence(root);
    expect(store.entries).toEqual([]);
    expect(store.onDisk).toBe(false);
  });

  it('refuses an observation that names no source', () => {
    const withoutSource: ObservationInput = {
      ...observation(),
      source: { kind: 'board-record', ref: '', date: '' },
    };
    expect(() => assertObservation(withoutSource)).toThrow(ConformanceError);
  });

  it('refuses an observation that says nothing', () => {
    expect(() => assertObservation(observation({ note: '  ' }))).toThrow(ConformanceError);
  });

  it('refuses an observation that carries no moment', () => {
    expect(() => assertObservation(observation({ at: 'yesterday' }))).toThrow(ConformanceError);
  });

  it('refuses an observation that names no capability', () => {
    expect(() => assertObservation(observation({ capabilityId: '' }))).toThrow(ConformanceError);
  });

  it('writes the observation and reads it back', async () => {
    await recordObservation(root, observation());
    const store = await readEvidence(root);
    expect(store.onDisk).toBe(true);
    const entry = store.entries[0];
    expect(entry?.capabilityId).toBe('session-family');
    expect(entry?.observations[0]?.source.ref).toBe('706');
  });

  it('keeps the newest observations and drops the rest', async () => {
    for (let index = 0; index < MAX_OBSERVATIONS + 3; index += 1) {
      await recordObservation(
        root,
        observation({ at: `2026-10-28T04:51:${String(index).padStart(2, '0')}.000Z` }),
      );
    }
    const store = await readEvidence(root);
    const entry = store.entries[0];
    expect(entry?.observations.length).toBe(MAX_OBSERVATIONS);
    expect(entry?.observations[0]?.at).toBe(
      `2026-10-28T04:51:${String(MAX_OBSERVATIONS + 2).padStart(2, '0')}.000Z`,
    );
  });

  it('says so when the file cannot be read', async () => {
    await recordObservation(root, observation());
    await rm(evidencePath(root));
    const store = await readEvidence(root);
    expect(store.onDisk).toBe(false);
  });
});

describe('the rule about what an observation proves', () => {
  it('counts a live observation and not a schema one', () => {
    const live: Observation = { ...observation() };
    const schema: Observation = { ...observation({ kind: 'schema' }) };
    expect(hasLiveObservation([schema])).toBe(false);
    expect(hasLiveObservation([schema, live])).toBe(true);
  });

  it('keeps the newest observation of the two', () => {
    const older: Observation = { ...observation({ at: '2026-10-01T00:00:00.000Z' }) };
    const newer: Observation = { ...observation({ at: '2026-10-28T00:00:00.000Z' }) };
    const merged = mergeObservations([older], [newer]);
    expect(merged[0]?.at).toBe('2026-10-28T00:00:00.000Z');
  });

  it('writes a schema observation without calling it a live one', async () => {
    await recordObservation(root, observation({ kind: 'schema' }));
    const store = await readEvidence(root);
    const entry = store.entries[0];
    expect(hasLiveObservation(entry?.observations ?? [])).toBe(false);
    expect(entry?.observations[0]?.kind).toBe('schema');
  });
});

describe('the file on disk', () => {
  it('holds the observations and nothing else', async () => {
    await recordObservation(root, observation());
    const raw = JSON.parse(await readFile(evidencePath(root), 'utf8'));
    expect(raw.version).toBe(1);
    expect(Object.keys(raw.capabilities)).toEqual(['session-family']);
  });
});
