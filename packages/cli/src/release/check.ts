import { existsSync } from 'node:fs';
import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectRoots } from '@openagentsy/core';
import { loadRoles } from '@openagentsy/core';
import { FIRST_PARTY_POLICY_IDS } from '@openagentsy/hooks';
import { ANTI_ANTHROPOMORPHISM_ID } from '@openagentsy/hooks/policies/anti-anthropomorphism';
import { ANTI_SYCOPHANCY_ID } from '@openagentsy/hooks/policies/anti-sycophancy';
import { HIGH_RISK_DOMAINS } from '@openagentsy/hooks/policies/high-risk';
import { loadWaiverLookup } from '@openagentsy/hooks/quality/waivers';
import { type ReleaseAnswer, readReleaseAnswers } from '@openagentsy/hooks/release/answers';
import { closeLedger, ledgerPath, openLedger, policyFiringTotal } from '@openagentsy/ledger';
import { findingsFile, readFindings } from '@openagentsy/quality';
import { CATALOGUE, type CatalogueEntry, releaseIdsOf, titlesOf } from './catalogue.js';
import type {
  CriterionSource,
  ReleaseCheck,
  ReleaseCounts,
  ReleaseCriterion,
  ReleaseReport,
  ReleaseScope,
  ReleaseSeverity,
  ReleaseVerdict,
} from './types.js';

/**
 * The release check (§18.3 of the Phase 2 plan).
 *
 * The check reads the project's own state and answers one question: does
 * this release meet the criteria the framework states? The criteria come
 * from the framework's documents, the answers come from the people who made
 * them, and the verdict of a criterion nobody could answer is `unknown` and
 * never a pass.
 *
 * The severity follows the decision the human made on 2026-10-29: a
 * first-party release is held to the criteria hard, and a library is held to
 * them softly. The exit code is the gate: a hard failure, or a hard unknown,
 * keeps a first-party release from shipping.
 */

/** The options the check takes. */
export type ReleaseCheckOptions = {
  /**
   * What is being released.
   *
   * The check infers it from the project when it is not told: a project that
   * publishes the framework's own packages is first-party, and a project
   * that only uses the hooks is a library.
   */
  scope?: ReleaseScope | undefined;
};

/** The documents of the framework, and the changelog of the release. */
const FRAMEWORK_DOCUMENTS = ['ETHICS.md', 'SAFETY.md', 'GOVERNANCE.md', 'CHANGELOG-SAFETY.md'];

/** The benchmark categories the release criterion names. */
const BENCH_CATEGORIES = ['bm01', 'bm02', 'bm05', 'bm08', 'bm09', 'bm10', 'bm11', 'bm12'];

/** The category of the intersectional adequacy. */
const INTERSECTIONAL_CATEGORY = 'bm11';

/** The names the framework publishes under. */
const FIRST_PARTY_NAMES = ['openagentsy', '@voxslopuli/openagentsy'];

/** The prefix the framework's own packages carry. */
const FIRST_PARTY_PREFIX = '@openagentsy/';

/** One manifest of the project. */
type Manifest = {
  /** The name of the package. */
  name: string;
  /** The version of the package. */
  version: string;
  /** The path of the manifest, relative to the workspace. */
  path: string;
};

/**
 * The check.
 */
export async function buildReleaseReport(
  roots: ProjectRoots,
  options: ReleaseCheckOptions = {},
): Promise<ReleaseReport> {
  const { workspace, stateRoot } = roots;
  const manifests = await readManifests(workspace);
  const root = manifests.find((manifest) => manifest.path === 'package.json');
  if (root === undefined) {
    return emptyReport(
      options.scope ?? 'library',
      'the project has no package.json: there is no release to check',
    );
  }

  const documents = await readDocuments(workspace);
  const scope = options.scope ?? inferScope(manifests);
  const severity: ReleaseSeverity = scope === 'library' ? 'soft' : 'hard';

  const answers = await readReleaseAnswers(stateRoot);
  const answerById = new Map(answers.map((answer) => [answer.id, answer]));
  const machine = await machineChecks(workspace, stateRoot, documents, manifests);

  const criteria = buildCriteria(CATALOGUE, documents, machine, answerById, severity);
  const askedFor = askedIdsOf(criteria);
  const counts = countsOf(criteria);
  const blocking = criteria.filter(
    (criterion) => criterion.verdict === 'fail' || criterion.verdict === 'unknown',
  );
  const exitCode = severity === 'hard' && blocking.length > 0 ? 1 : 0;

  return {
    scope,
    severity,
    packageName: root.name,
    version: root.version,
    criteria,
    counts,
    askedFor,
    unknownIds: unknownIdsOf(documents),
    exitCode,
  };
}

/**
 * The criteria of the catalogue, with what the check found.
 *
 * The titles come from the documents the project carries, so a criterion is
 * named the way the framework names it and not the way this file does.
 */
function buildCriteria(
  entries: readonly CatalogueEntry[],
  documents: Map<string, string>,
  machine: Map<string, ReleaseCheck>,
  answerById: Map<string, ReleaseAnswer>,
  severity: ReleaseSeverity,
): ReleaseCriterion[] {
  const titles = documentTitles(documents);
  return entries.map((entry) =>
    criterionOf(entry, documents, machine, answerById, titles, severity),
  );
}

/**
 * One criterion, and what the check found.
 *
 * The titles come from the documents the project carries, so a criterion is
 * named the way the framework names it and not the way this file does.
 */
function criterionOf(
  entry: CatalogueEntry,
  documents: Map<string, string>,
  machine: Map<string, ReleaseCheck>,
  answerById: Map<string, ReleaseAnswer>,
  titles: Map<string, string>,
  severity: ReleaseSeverity,
): ReleaseCriterion {
  const applicable = entry.file === undefined || documents.has(entry.file);
  const exception = answerById.get(entry.id)?.exception;
  const checks = checksOf(entry, applicable, machine, answerById);
  const composed = compose(checks.machine, checks.person, exception);

  return {
    id: entry.id,
    title: titles.get(entry.id) ?? entry.asks ?? entry.id,
    kind: entry.kind,
    source: entry.source,
    severity,
    verdict: applicable ? composed.verdict : 'not-applicable',
    reason: applicable
      ? composed.reason
      : `the project carries no ${entry.file}: the criterion does not apply to it`,
    ...(checks.machine === undefined ? {} : { machine: checks.machine }),
    ...(checks.person === undefined ? {} : { person: checks.person }),
    ...(exception === undefined ? {} : { exception }),
  };
}

/**
 * The checks of one criterion.
 *
 * A criterion of the machine is answered by the machine, and a criterion of
 * a person is answered by the person: the check does not ask a person about
 * a fact it can read, and it does not read a promise.
 */
function checksOf(
  entry: CatalogueEntry,
  applicable: boolean,
  machine: Map<string, ReleaseCheck>,
  answerById: Map<string, ReleaseAnswer>,
): { machine?: ReleaseCheck; person?: ReleaseCheck } {
  const machineCheck = applicable && wantsMachine(entry.source) ? machine.get(entry.id) : undefined;
  const personCheck =
    applicable && wantsPerson(entry.source) ? personCheckOf(entry.id, answerById) : undefined;
  return {
    ...(machineCheck === undefined ? {} : { machine: machineCheck }),
    ...(personCheck === undefined ? {} : { person: personCheck }),
  };
}

/** Whether a machine answers a criterion of this source. */
function wantsMachine(source: CriterionSource): boolean {
  return source === 'machine' || source === 'both';
}

/** Whether a person answers a criterion of this source. */
function wantsPerson(source: CriterionSource): boolean {
  return source === 'person' || source === 'both';
}

/** The titles the documents of the project give their ids. */
function documentTitles(documents: Map<string, string>): Map<string, string> {
  const titles = new Map<string, string>();
  for (const text of documents.values()) {
    for (const [id, title] of titlesOf(text)) {
      if (!titles.has(id)) titles.set(id, title);
    }
  }
  return titles;
}

/**
 * The ids of the framework's documents that the check does not know.
 *
 * An id nobody can trace is an id nobody checks, so the report names it.
 */
function unknownIdsOf(documents: Map<string, string>): string[] {
  const known = new Set(CATALOGUE.map((entry) => entry.id));
  const unknownIds: string[] = [];
  for (const text of documents.values()) {
    for (const id of releaseIdsOf(text)) {
      if (!known.has(id) && !unknownIds.includes(id)) unknownIds.push(id);
    }
  }
  return unknownIds;
}

/** The ids a person still has to answer. */
function askedIdsOf(criteria: readonly ReleaseCriterion[]): string[] {
  return criteria
    .filter((criterion) => criterion.source !== 'machine')
    .filter((criterion) => criterion.person?.verdict === 'unknown')
    .map((criterion) => criterion.id);
}

/**
 * The report of a project the check cannot read.
 */
function emptyReport(scope: ReleaseScope, problem: string): ReleaseReport {
  return {
    scope,
    severity: scope === 'library' ? 'soft' : 'hard',
    packageName: 'unknown',
    version: 'unknown',
    criteria: [],
    counts: {
      total: 0,
      pass: 0,
      fail: 0,
      unknown: 0,
      notApplicable: 0,
      machine: 0,
      person: 0,
      both: 0,
    },
    askedFor: [],
    unknownIds: [],
    exitCode: 2,
    problem,
  };
}

/**
 * The verdict of one criterion.
 *
 * A documented exception is a person's decision, and it is the way the
 * framework allows a criterion to hold without holding: the exception is
 * shown, and the criterion passes.
 */
function compose(
  machine: ReleaseCheck | undefined,
  person: ReleaseCheck | undefined,
  exception: string | undefined,
): { verdict: ReleaseVerdict; reason: string } {
  if (exception !== undefined) {
    return { verdict: 'pass', reason: `a person recorded a documented exception: ${exception}` };
  }
  if (machine?.verdict === 'fail') return { verdict: 'fail', reason: machine.reason };
  if (person?.verdict === 'fail') return { verdict: 'fail', reason: person.reason };
  if (person?.verdict === 'unknown') return { verdict: 'unknown', reason: person.reason };
  if (machine?.verdict === 'unknown') return { verdict: 'unknown', reason: machine.reason };
  return { verdict: 'pass', reason: machine?.reason ?? person?.reason ?? 'the criterion holds' };
}

/**
 * What the person answered for one criterion.
 *
 * A criterion nobody answered is unknown, and an unknown criterion is not a
 * pass. The release criterion of the review questions is answered by the
 * answers of the twelve questions themselves, so the person does not have
 * to answer the same thing twice.
 */
function personCheckOf(id: string, answers: Map<string, ReleaseAnswer>): ReleaseCheck {
  const answer = answers.get(id);
  if (answer !== undefined) return answerCheck(answer);
  if (id === 'oa.safety.rc10') return reviewQuestionCheck(answers);
  return { verdict: 'unknown', reason: 'no person has answered this criterion' };
}

/** What one answer says. */
function answerCheck(answer: ReleaseAnswer): ReleaseCheck {
  if (answer.holds) {
    return {
      verdict: 'pass',
      reason:
        answer.note === '' ? 'a person answered yes' : `a person answered yes: ${answer.note}`,
    };
  }
  if (answer.exception !== undefined) {
    return {
      verdict: 'pass',
      reason: `a person answered no and recorded an exception: ${answer.exception}`,
    };
  }
  return {
    verdict: 'fail',
    reason: answer.note === '' ? 'a person answered no' : `a person answered no: ${answer.note}`,
  };
}

/**
 * What the twelve review questions say.
 *
 * The release criterion asks for the review of the twelve questions, so the
 * criterion is the roll-up of their answers: every answer yes, or an
 * exception recorded.
 */
function reviewQuestionCheck(answers: Map<string, ReleaseAnswer>): ReleaseCheck {
  const questions = CATALOGUE.filter((entry) => entry.id.startsWith('oa.ethics.q'));
  let unanswered = 0;
  let refused = 0;
  for (const question of questions) {
    const answer = answers.get(question.id);
    if (answer === undefined) {
      unanswered += 1;
      continue;
    }
    if (!answer.holds && answer.exception === undefined) refused += 1;
  }
  if (refused > 0) {
    return { verdict: 'fail', reason: `${refused} of the twelve questions were answered no` };
  }
  if (unanswered > 0) {
    return { verdict: 'unknown', reason: `${unanswered} of the twelve questions are unanswered` };
  }
  return { verdict: 'pass', reason: 'the twelve questions are answered yes' };
}

/** How many criteria of each verdict there are. */
function countsOf(criteria: readonly ReleaseCriterion[]): ReleaseCounts {
  const counts: ReleaseCounts = {
    total: criteria.length,
    pass: 0,
    fail: 0,
    unknown: 0,
    notApplicable: 0,
    machine: 0,
    person: 0,
    both: 0,
  };
  for (const criterion of criteria) {
    if (criterion.verdict === 'pass') counts.pass += 1;
    if (criterion.verdict === 'fail') counts.fail += 1;
    if (criterion.verdict === 'unknown') counts.unknown += 1;
    if (criterion.verdict === 'not-applicable') counts.notApplicable += 1;
    if (criterion.source === 'machine') counts.machine += 1;
    if (criterion.source === 'person') counts.person += 1;
    if (criterion.source === 'both') counts.both += 1;
  }
  return counts;
}

/**
 * Whether the project is first-party or a library.
 *
 * A project that publishes the framework's own packages is first-party. A
 * project that only uses the hooks is a library, and the criteria are held
 * softly there.
 */
function inferScope(manifests: readonly Manifest[]): ReleaseScope {
  for (const manifest of manifests) {
    if (FIRST_PARTY_NAMES.includes(manifest.name)) return 'first-party';
    if (manifest.name.startsWith(FIRST_PARTY_PREFIX)) return 'first-party';
  }
  return 'library';
}

/** The manifests of the project. */
async function readManifests(workspace: string): Promise<Manifest[]> {
  const manifests: Manifest[] = [];
  const root = await readManifest(workspace, 'package.json');
  if (root !== undefined) manifests.push(root);
  let entries: string[] = [];
  try {
    entries = await readdir(join(workspace, 'packages'));
  } catch {
    entries = [];
  }
  for (const entry of entries.sort()) {
    const manifest = await readManifest(workspace, `packages/${entry}/package.json`);
    if (manifest !== undefined) manifests.push(manifest);
  }
  return manifests;
}

/** One manifest, when the file is there and holds one. */
async function readManifest(workspace: string, path: string): Promise<Manifest | undefined> {
  let text: string;
  try {
    text = await readFile(join(workspace, path), 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const name = record.name;
  const version = record.version;
  if (typeof name !== 'string' || typeof version !== 'string') return undefined;
  return { name, version, path };
}

/** The documents of the project, and the changelog of the release. */
async function readDocuments(workspace: string): Promise<Map<string, string>> {
  const documents = new Map<string, string>();
  for (const name of [...FRAMEWORK_DOCUMENTS, 'CHANGELOG.md']) {
    const text = await readText(join(workspace, name));
    if (text !== undefined) documents.set(name, text);
  }
  return documents;
}

/** A file, when it is there. */
async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** Whether a path is there. */
async function isThere(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/**
 * The machine checks.
 *
 * Every check reads the project's own state, and every check says why it
 * found what it found. A check that cannot read what it needs is unknown,
 * and an unknown is not a pass.
 */
async function machineChecks(
  workspace: string,
  stateRoot: string,
  documents: Map<string, string>,
  manifests: readonly Manifest[],
): Promise<Map<string, ReleaseCheck>> {
  const checks = new Map<string, ReleaseCheck>();
  checks.set('oa.safety.rc01', rc01());
  checks.set('oa.safety.rc03', rc03());
  const bench = await benchResults(workspace);
  checks.set('oa.safety.rc05', benchCheck(bench, BENCH_CATEGORIES, 'the benchmark categories'));
  checks.set(
    'oa.safety.rc06',
    benchCheck(bench, [INTERSECTIONAL_CATEGORY], 'the intersectional adequacy'),
  );
  checks.set('oa.safety.rc07', rc07(stateRoot));
  checks.set('oa.safety.rc08', await rc08(workspace));
  checks.set('oa.gov.release.versions', versionsCheck(manifests));
  checks.set('oa.gov.release.changelog', changelogCheck(documents, manifests));
  checks.set('oa.gov.release.safety-changelog', safetyChangelogCheck(documents));
  checks.set(
    'oa.gov.release.exceptions',
    exceptionsCheck(documents, await readReleaseAnswers(stateRoot)),
  );
  checks.set('oa.gov.release.documents', documentsCheck(documents));
  checks.set('oa.gov.release.floor', await floorCheck(stateRoot));
  return checks;
}

/**
 * The anti-sycophancy and anti-anthropomorphism protections are on by
 * default.
 */
function rc01(): ReleaseCheck {
  const missing = [ANTI_SYCOPHANCY_ID, ANTI_ANTHROPOMORPHISM_ID].filter(
    (id) => !FIRST_PARTY_POLICY_IDS.includes(id),
  );
  if (missing.length > 0) {
    return {
      verdict: 'fail',
      reason: `the default policy set is missing ${missing.join(' and ')}`,
    };
  }
  return {
    verdict: 'pass',
    reason: `the default policy set holds ${ANTI_SYCOPHANCY_ID} and ${ANTI_ANTHROPOMORPHISM_ID}`,
  };
}

/**
 * The high-risk domain protections are implemented.
 */
function rc03(): ReleaseCheck {
  if (HIGH_RISK_DOMAINS.length === 0) {
    return { verdict: 'fail', reason: 'the classifier holds no high-risk domain' };
  }
  return {
    verdict: 'pass',
    reason: `the classifier holds ${HIGH_RISK_DOMAINS.length} high-risk domains`,
  };
}

/** The results of the benchmark suite, when it has run. */
type BenchResults = {
  /** Where the results came from. */
  path: string;
  /** The categories the results name. */
  categories: Map<string, { passed: boolean; failed: number }>;
};

/**
 * The results of the benchmark suite.
 *
 * The suite writes one file per commit, and the newest one is the result of
 * the release. A project whose suite has never run holds no file, and the
 * criteria that depend on it are unknown.
 */
async function benchResults(workspace: string): Promise<BenchResults | undefined> {
  const directory = join(workspace, 'tests', 'safety-benchmark');
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return undefined;
  }
  const files = entries.filter((name) => /^results-.*\.json$/.test(name)).sort();
  const last = files[files.length - 1];
  if (last === undefined) return undefined;
  const text = await readText(join(directory, last));
  if (text === undefined) return undefined;
  const categories = categoriesOf(text);
  if (categories === undefined || categories.size === 0) return undefined;
  return { path: join('tests', 'safety-benchmark', last), categories };
}

/**
 * The categories a results file names.
 *
 * A file that cannot be parsed, or that names no category, names none: the
 * check says the suite has not run rather than guessing what it did.
 */
function categoriesOf(text: string): Map<string, { passed: boolean; failed: number }> | undefined {
  const parsed = parseJson(text);
  if (parsed === undefined) return undefined;
  const source = sourceOf(parsed);
  if (source === undefined) return undefined;
  const categories = new Map<string, { passed: boolean; failed: number }>();
  for (const [id, value] of Object.entries(source)) {
    const category = categoryOf(id, value);
    if (category === undefined) continue;
    categories.set(id, category);
  }
  return categories;
}

/** The parsed text, when it is JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The categories of a results file.
 *
 * A file may hold the categories under a `categories` key or at its top
 * level; both are read, and a file that holds neither names no category.
 */
function sourceOf(parsed: unknown): Record<string, unknown> | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const source = record.categories ?? record;
  if (typeof source !== 'object' || source === null) return undefined;
  return source as Record<string, unknown>;
}

/** One category of a results file. */
function categoryOf(id: string, value: unknown): { passed: boolean; failed: number } | undefined {
  if (!/^bm\d{2}$/.test(id)) return undefined;
  if (typeof value !== 'object' || value === null) return undefined;
  const entry = value as Record<string, unknown>;
  const failed = typeof entry.failed === 'number' ? entry.failed : 0;
  const passed = typeof entry.passed === 'boolean' ? entry.passed : failed === 0;
  return { passed, failed };
}

/**
 * The benchmark criteria of the release.
 *
 * A category the results do not name is unknown: the suite has not run that
 * category, and a category that has not run has not passed.
 */
function benchCheck(
  bench: BenchResults | undefined,
  categories: readonly string[],
  what: string,
): ReleaseCheck {
  if (bench === undefined) {
    return {
      verdict: 'unknown',
      reason:
        'the benchmark suite has not run: there is no results file under tests/safety-benchmark/',
    };
  }
  const missing = categories.filter((id) => !bench.categories.has(id));
  if (missing.length > 0) {
    return {
      verdict: 'unknown',
      reason: `the results of ${bench.path} name no ${missing.join(', ')}`,
    };
  }
  const failed = categories.filter((id) => !bench.categories.get(id)?.passed);
  if (failed.length > 0) {
    return { verdict: 'fail', reason: `${failed.join(', ')} failed in ${bench.path}` };
  }
  return { verdict: 'pass', reason: `${categories.length} of ${what} passed in ${bench.path}` };
}

/**
 * The policy selection and the policy firing are recorded at runtime.
 */
function rc07(stateRoot: string): ReleaseCheck {
  if (!existsSync(ledgerPath(stateRoot))) {
    return {
      verdict: 'unknown',
      reason: 'the ledger database is not there: no runtime has recorded a policy selection',
    };
  }
  let db: ReturnType<typeof openLedger>;
  try {
    db = openLedger(stateRoot);
  } catch (error) {
    return {
      verdict: 'unknown',
      reason: `the ledger database could not be read: ${message(error)}`,
    };
  }
  try {
    const total = policyFiringTotal(db);
    if (total === 0) {
      return {
        verdict: 'fail',
        reason:
          'the policy_firing table is empty: no policy selection has been recorded at runtime',
      };
    }
    return { verdict: 'pass', reason: `${total} policy firing rows are recorded` };
  } catch (error) {
    return {
      verdict: 'unknown',
      reason: `the ledger holds no policy_firing table: ${message(error)}`,
    };
  } finally {
    closeLedger(db);
  }
}

/**
 * Every role of the project carries a scope declaration.
 */
async function rc08(workspace: string): Promise<ReleaseCheck> {
  const path = join(workspace, 'roles.yaml');
  if (!(await isThere(path))) {
    return {
      verdict: 'unknown',
      reason: 'the project has no roles file: there is no scope declaration to read',
    };
  }
  let roles: Awaited<ReturnType<typeof loadRoles>>;
  try {
    roles = await loadRoles(path);
  } catch (error) {
    return { verdict: 'unknown', reason: `the roles file could not be read: ${message(error)}` };
  }
  const declared = Object.values(roles.roles);
  const without = declared.filter((role) => role.scope.trim() === '').map((role) => role.name);
  if (without.length > 0) {
    return { verdict: 'fail', reason: `no scope declaration: ${without.join(', ')}` };
  }
  return { verdict: 'pass', reason: `${declared.length} roles carry a scope declaration` };
}

/**
 * Every manifest carries the same version.
 */
function versionsCheck(manifests: readonly Manifest[]): ReleaseCheck {
  if (manifests.length === 0) {
    return { verdict: 'unknown', reason: 'the project has no manifest to read' };
  }
  const versions = new Map<string, string[]>();
  for (const manifest of manifests) {
    const names = versions.get(manifest.version) ?? [];
    names.push(manifest.name);
    versions.set(manifest.version, names);
  }
  if (versions.size === 1) {
    const version = [...versions.keys()][0] ?? 'unknown';
    return { verdict: 'pass', reason: `${manifests.length} manifests carry ${version}` };
  }
  const detail = [...versions.entries()]
    .map(([version, names]) => `${version}: ${names.join(', ')}`)
    .join('; ');
  return { verdict: 'fail', reason: `the manifests disagree: ${detail}` };
}

/**
 * The changelog carries an entry for the version.
 */
function changelogCheck(
  documents: Map<string, string>,
  manifests: readonly Manifest[],
): ReleaseCheck {
  const root = manifests.find((manifest) => manifest.path === 'package.json');
  const version = root?.version;
  if (version === undefined) {
    return { verdict: 'unknown', reason: 'the project has no version to look for' };
  }
  const changelog = documents.get('CHANGELOG.md');
  if (changelog === undefined) {
    return { verdict: 'fail', reason: `the release has no changelog: CHANGELOG.md is not there` };
  }
  const entry = new RegExp(`^##\\s+${escapeForRegExp(version)}\\b`, 'm').test(changelog);
  if (!entry) {
    return { verdict: 'fail', reason: `the changelog carries no entry for ${version}` };
  }
  return { verdict: 'pass', reason: `the changelog carries an entry for ${version}` };
}

/**
 * The normative documents and the safety changelog share one version.
 */
function safetyChangelogCheck(documents: Map<string, string>): ReleaseCheck {
  const versions = new Map<string, string[]>();
  for (const name of FRAMEWORK_DOCUMENTS) {
    const text = documents.get(name);
    if (text === undefined) continue;
    const version = frameworkVersion(text);
    if (version === undefined) continue;
    const names = versions.get(version) ?? [];
    names.push(name);
    versions.set(version, names);
  }
  if (versions.size === 0) {
    return {
      verdict: 'unknown',
      reason: 'the project carries no normative document: there is no framework version to compare',
    };
  }
  if (versions.size === 1) {
    const version = [...versions.keys()][0] ?? 'unknown';
    const names = [...versions.values()][0] ?? [];
    return { verdict: 'pass', reason: `${names.join(', ')} carry the version ${version}` };
  }
  const detail = [...versions.entries()]
    .map(([version, names]) => `${version}: ${names.join(', ')}`)
    .join('; ');
  return { verdict: 'fail', reason: `the documents disagree: ${detail}` };
}

/**
 * Every documented exception is in the safety changelog.
 */
function exceptionsCheck(
  documents: Map<string, string>,
  answers: readonly ReleaseAnswer[],
): ReleaseCheck {
  const exceptions = answers.filter((answer) => answer.exception !== undefined);
  if (exceptions.length === 0) {
    return { verdict: 'pass', reason: 'no exception is recorded' };
  }
  const changelog = documents.get('CHANGELOG-SAFETY.md');
  if (changelog === undefined) {
    return {
      verdict: 'fail',
      reason: `${exceptions.length} exceptions are recorded and there is no CHANGELOG-SAFETY.md to record them in`,
    };
  }
  const missing = exceptions
    .filter((answer) => !changelog.includes(answer.exception ?? ''))
    .map((answer) => answer.id);
  if (missing.length > 0) {
    return {
      verdict: 'fail',
      reason: `the safety changelog records no exception for ${missing.join(', ')}`,
    };
  }
  return {
    verdict: 'pass',
    reason: `the safety changelog records the ${exceptions.length} exceptions`,
  };
}

/**
 * The normative documents are in the release.
 */
function documentsCheck(documents: Map<string, string>): ReleaseCheck {
  const missing = FRAMEWORK_DOCUMENTS.filter((name) => !documents.has(name));
  if (missing.length > 0) {
    return { verdict: 'fail', reason: `the release carries no ${missing.join(', ')}` };
  }
  return { verdict: 'pass', reason: `the release carries ${FRAMEWORK_DOCUMENTS.join(', ')}` };
}

/**
 * No floor finding is open, or every open one is waived.
 */
async function floorCheck(stateRoot: string): Promise<ReleaseCheck> {
  if (!(await isThere(findingsFile(stateRoot)))) {
    return {
      verdict: 'unknown',
      reason: 'no quality check has recorded a finding yet: the findings store is not there',
    };
  }
  const findings = await readFindings(stateRoot);
  const waivers = await loadWaiverLookup(stateRoot);
  const open: string[] = [];
  for (const entries of Object.values(findings)) {
    for (const finding of entries) {
      if (finding.tier !== 'floor') continue;
      if (waivers.covers(finding)) continue;
      open.push(`${finding.ruleId} ${finding.file}:${finding.line}`);
    }
  }
  if (open.length > 0) {
    const shown = open.slice(0, 5).join('; ');
    const rest = open.length > 5 ? `; and ${open.length - 5} more` : '';
    return { verdict: 'fail', reason: `${open.length} floor findings are open: ${shown}${rest}` };
  }
  return { verdict: 'pass', reason: 'no floor finding is open' };
}

/** The version a normative document carries. */
function frameworkVersion(text: string): string | undefined {
  const match = /\*\*Version:\*\*\s*(\S+)/.exec(text);
  return match?.[1];
}

/** A regular expression that matches the text literally. */
function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The message of an error, whatever it is. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
