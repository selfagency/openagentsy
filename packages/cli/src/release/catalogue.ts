/**
 * The catalogue of release criteria (§18.3 of the Phase 2 plan).
 *
 * The check does not invent criteria. The ids are the ids the framework's
 * own documents carry, and the title of a criterion is the title the
 * document gives it: the check reads `ETHICS.md` and `SAFETY.md` and takes
 * the wording from there, so a document that renames a criterion and the
 * report cannot drift apart.
 *
 * The ids below are the framework's, and the check confirms them against the
 * documents at runtime: an id the documents carry and this catalogue does
 * not know is reported, because an id nobody can trace is an id nobody
 * checks.
 */

import type { CriterionKind, CriterionSource } from './types.js';

/** The twelve commitments of `ETHICS.md`. */
const ETHICS_COMMITMENT_IDS: readonly string[] = [
  'oa.ethics.c01',
  'oa.ethics.c02',
  'oa.ethics.c03',
  'oa.ethics.c04',
  'oa.ethics.c05',
  'oa.ethics.c06',
  'oa.ethics.c07',
  'oa.ethics.c08',
  'oa.ethics.c09',
  'oa.ethics.c10',
  'oa.ethics.c11',
  'oa.ethics.c12',
];

/** The thirteen prohibited first-party patterns of `ETHICS.md`. */
const ETHICS_PATTERN_IDS: readonly string[] = [
  'oa.ethics.p01',
  'oa.ethics.p02',
  'oa.ethics.p03',
  'oa.ethics.p04',
  'oa.ethics.p05',
  'oa.ethics.p06',
  'oa.ethics.p07',
  'oa.ethics.p08',
  'oa.ethics.p09',
  'oa.ethics.p10',
  'oa.ethics.p11',
  'oa.ethics.p12',
  'oa.ethics.p13',
];

/** The twelve ethics review questions of `ETHICS.md`. */
const ETHICS_QUESTION_IDS: readonly string[] = [
  'oa.ethics.q01',
  'oa.ethics.q02',
  'oa.ethics.q03',
  'oa.ethics.q04',
  'oa.ethics.q05',
  'oa.ethics.q06',
  'oa.ethics.q07',
  'oa.ethics.q08',
  'oa.ethics.q09',
  'oa.ethics.q10',
  'oa.ethics.q11',
  'oa.ethics.q12',
];

/** The ten release criteria of `SAFETY.md`. */
const SAFETY_CRITERION_IDS: readonly string[] = [
  'oa.safety.rc01',
  'oa.safety.rc02',
  'oa.safety.rc03',
  'oa.safety.rc04',
  'oa.safety.rc05',
  'oa.safety.rc06',
  'oa.safety.rc07',
  'oa.safety.rc08',
  'oa.safety.rc09',
  'oa.safety.rc10',
];

/**
 * Who answers each release criterion.
 *
 * A criterion a machine can read is answered by the machine, a criterion
 * that is a judgement is answered by a person, and one that is both — the
 * scope declaration of `rc08` — carries both answers.
 */
const RELEASE_CRITERION_SOURCES: Record<string, CriterionSource> = {
  'oa.safety.rc01': 'machine',
  'oa.safety.rc02': 'person',
  'oa.safety.rc03': 'machine',
  'oa.safety.rc04': 'person',
  'oa.safety.rc05': 'machine',
  'oa.safety.rc06': 'machine',
  'oa.safety.rc07': 'machine',
  'oa.safety.rc08': 'both',
  'oa.safety.rc09': 'person',
  'oa.safety.rc10': 'person',
};

/** One criterion of the catalogue. */
export type CatalogueEntry = {
  /** The stable id of the criterion. */
  id: string;
  /** What the criterion belongs to. */
  kind: CriterionKind;
  /** Who answers it. */
  source: CriterionSource;
  /**
   * The file the criterion is written in.
   *
   * A criterion of a document the project does not carry does not apply to
   * it: a library that ships no `ETHICS.md` is not bound by the twelve
   * commitments, and the report says so instead of failing the release.
   */
  file: string | undefined;
  /**
   * What the criterion asks for.
   *
   * The criteria of the framework's documents take their wording from the
   * document at runtime. The check's own criteria have no document, so they
   * carry their wording here.
   */
  asks?: string | undefined;
};

/**
 * The catalogue.
 *
 * The order is the order a person reads: the commitments, the prohibited
 * patterns, the review questions, the release criteria, and the criteria of
 * the governance the check can read for itself.
 */
export const CATALOGUE: readonly CatalogueEntry[] = [
  ...ETHICS_COMMITMENT_IDS.map((id) => ({
    id,
    kind: 'ethics' as const,
    source: 'person' as const,
    file: 'ETHICS.md',
  })),
  ...ETHICS_PATTERN_IDS.map((id) => ({
    id,
    kind: 'ethics' as const,
    source: 'person' as const,
    file: 'ETHICS.md',
  })),
  ...ETHICS_QUESTION_IDS.map((id) => ({
    id,
    kind: 'ethics' as const,
    source: 'person' as const,
    file: 'ETHICS.md',
  })),
  ...SAFETY_CRITERION_IDS.map((id) => ({
    id,
    kind: 'safety' as const,
    source: RELEASE_CRITERION_SOURCES[id] ?? ('person' as const),
    file: 'SAFETY.md',
  })),
  {
    id: 'oa.gov.release.versions',
    kind: 'governance',
    source: 'machine',
    file: undefined,
    asks: 'Every manifest of the release carries the same version.',
  },
  {
    id: 'oa.gov.release.changelog',
    kind: 'governance',
    source: 'machine',
    file: undefined,
    asks: 'The changelog carries an entry for the version of the release.',
  },
  {
    id: 'oa.gov.release.safety-changelog',
    kind: 'governance',
    source: 'machine',
    file: undefined,
    asks: 'The normative documents and the safety changelog share one version.',
  },
  {
    id: 'oa.gov.release.exceptions',
    kind: 'governance',
    source: 'machine',
    file: undefined,
    asks: 'Every documented exception is recorded in the safety changelog.',
  },
  {
    id: 'oa.gov.release.documents',
    kind: 'governance',
    source: 'machine',
    file: undefined,
    asks: 'The normative documents of the framework are in the release.',
  },
  {
    id: 'oa.gov.release.floor',
    kind: 'governance',
    source: 'machine',
    file: undefined,
    asks: 'No floor finding is open, or every open one is waived.',
  },
];

/**
 * The ids the check reads out of the framework's documents.
 *
 * The families of the documents are many: the guardrail layers, the
 * behavioural rules, the benchmark categories, the metrics and the incident
 * runbook are not release criteria. Only the ids a release is held to are
 * read, and an id of those families that the catalogue does not know is
 * reported.
 */
const RELEASE_ID = /^oa\.(?:ethics\.[cpq]\d+|safety\.rc\d+|gov\.release\.[a-z0-9.-]+)$/;

/** The ids of the framework's documents that a release is held to. */
export function releaseIdsOf(text: string): string[] {
  const found: string[] = [];
  const pattern = /`([a-z]+\.[a-z]+\.[a-z0-9.-]+)`/g;
  let match = pattern.exec(text);
  while (match !== null) {
    const id = match[1];
    if (id !== undefined && RELEASE_ID.test(id) && !found.includes(id)) found.push(id);
    match = pattern.exec(text);
  }
  return found;
}

/**
 * The titles the documents give their ids.
 *
 * The title is the wording that follows the id on the line, without the
 * dashes that join it to the id. A line that names several ids gives its
 * wording to the first one, which is the one the sentence is about.
 */
export function titlesOf(text: string): Map<string, string> {
  const titles = new Map<string, string>();
  const lines = text.split('\n');
  for (const line of lines) {
    const matches = [...line.matchAll(/`([a-z]+\.[a-z]+\.[a-z0-9.-]+)`/g)];
    const first = matches[0];
    if (first === undefined) continue;
    const id = first[1];
    if (id === undefined) continue;
    // A line that names two ids names a range, and the wording of a range
    // belongs to neither of them.
    if (matches.length > 1) continue;
    if (titles.has(id)) continue;
    const after = line.slice(first.index + first[0].length);
    const title = after
      .replace(/^\s*[*_]*\s*[—–-]\s*/, '')
      .replace(/[,\s]+$/, '')
      .trim();
    if (title === '') continue;
    titles.set(id, title);
  }
  return titles;
}
