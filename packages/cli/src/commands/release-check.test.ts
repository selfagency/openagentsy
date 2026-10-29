import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeLedger, openLedger } from '@openagentsy/ledger';
import { describe, expect, it } from 'vitest';
import { CATALOGUE } from '../release/catalogue.js';
import { formatReleaseReport, runReleaseAnswer, runReleaseCheck } from './release-check.js';

/**
 * The documents of the framework, as the check reads them.
 */
const FRAMEWORK_DOCUMENTS = ['ETHICS.md', 'SAFETY.md', 'GOVERNANCE.md', 'CHANGELOG-SAFETY.md'];

/** What the fixture is. */
type Fixture = {
  /** The root of the project: the workspace and the state root are one directory. */
  root: string;
  /** The roots the command takes. */
  roots: { workspace: string; stateRoot: string };
  /** Take the fixture away. */
  remove: () => Promise<void>;
};

/** What the fixture holds. */
type FixtureOptions = {
  /** The name of the package: a library is not a first-party name. */
  name?: string;
  /** Whether a floor finding is open. */
  floorFinding?: boolean;
  /** Whether the people answered the criteria. */
  answered?: boolean;
  /** Whether the benchmark suite has run. */
  bench?: boolean;
};

/**
 * A project the check can read.
 *
 * The documents are the framework's own, so the check reads the real ids and
 * the real titles, and everything else the check needs is here: a manifest,
 * a changelog, a roles file, the benchmark results, a ledger with a policy
 * firing in it, a findings store and the answers of the people.
 */
async function project(options: FixtureOptions = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'openagentsy-release-check-'));

  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({ name: options.name ?? 'openagentsy', version: '0.1.0' }, null, 2)}\n`,
  );
  for (const document of FRAMEWORK_DOCUMENTS) {
    await copyFile(new URL(`../../../../${document}`, import.meta.url), join(root, document));
  }
  await writeFile(join(root, 'CHANGELOG.md'), '# Changelog\n\n## 0.1.0 - 2026-10-29\n');
  await copyFile(new URL('../../../../roles.yaml', import.meta.url), join(root, 'roles.yaml'));

  if (options.bench !== false) {
    await mkdir(join(root, 'tests', 'safety-benchmark'), { recursive: true });
    const categories: Record<string, { passed: boolean; scenarios: number; failed: number }> = {};
    for (let index = 1; index <= 12; index += 1) {
      categories[`bm${String(index).padStart(2, '0')}`] = { passed: true, scenarios: 3, failed: 0 };
    }
    await writeFile(
      join(root, 'tests', 'safety-benchmark', 'results-test.json'),
      `${JSON.stringify({ version: 1, categories }, null, 2)}\n`,
    );
  }

  await mkdir(join(root, '.openagentsy', 'quality'), { recursive: true });
  await mkdir(join(root, '.openagentsy', 'release'), { recursive: true });

  const db = openLedger(root);
  db.query(
    'INSERT INTO policy_firing (id, session_id, policy_id, policy_version, layer, action, severity, reason, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    'firing-1',
    'session-1',
    'oa.anti-sycophancy',
    '1.0.0',
    4,
    'allow',
    'low',
    'the fixture ran a policy',
    '2026-10-29T00:00:00.000Z',
  );
  closeLedger(db);

  const tasks =
    options.floorFinding === true
      ? {
          'bean-1': [
            {
              ruleId: 'css/contrast',
              source: 'quality',
              tier: 'floor',
              file: 'src/app.css',
              line: 12,
              message: 'the contrast is too low',
              fix: 'darken the text',
            },
          ],
        }
      : {};
  await writeFile(
    join(root, '.openagentsy', 'quality', 'findings.json'),
    `${JSON.stringify({ version: 1, tasks }, null, 2)}\n`,
  );

  if (options.answered !== false) {
    const answers = CATALOGUE.filter(
      (entry) => entry.source !== 'machine' && entry.id !== 'oa.safety.rc10',
    ).map((entry) => ({
      id: entry.id,
      holds: true,
      note: 'the fixture answers yes',
      decidedBy: 'human',
      ts: '2026-10-29T00:00:00.000Z',
    }));
    await writeFile(
      join(root, '.openagentsy', 'release', 'answers.json'),
      `${JSON.stringify({ version: 1, answers }, null, 2)}\n`,
    );
  }

  return {
    root,
    roots: { workspace: root, stateRoot: root },
    remove: () => rm(root, { recursive: true, force: true }),
  };
}

/** The criterion of a report, by its id. */
function criterionOf(
  report: Awaited<ReturnType<typeof runReleaseCheck>>,
  id: string,
): { verdict: string; reason: string } | undefined {
  const criterion = report.criteria.find((entry) => entry.id === id);
  return criterion === undefined
    ? undefined
    : { verdict: criterion.verdict, reason: criterion.reason };
}

describe('the release check', () => {
  it('passes a first-party release that meets every criterion', async () => {
    const fixture = await project();
    try {
      const report = await runReleaseCheck(fixture.roots);
      expect(report.scope).toBe('first-party');
      expect(report.severity).toBe('hard');
      expect(report.counts.fail).toBe(0);
      expect(report.counts.unknown).toBe(0);
      expect(report.exitCode).toBe(0);
      expect(formatReleaseReport(report)).toContain('every criterion holds');
    } finally {
      await fixture.remove();
    }
  });

  it('fails a first-party release with an open floor finding, and names it', async () => {
    const fixture = await project({ floorFinding: true });
    try {
      const report = await runReleaseCheck(fixture.roots);
      expect(report.exitCode).not.toBe(0);
      const floor = criterionOf(report, 'oa.gov.release.floor');
      expect(floor?.verdict).toBe('fail');
      expect(floor?.reason).toContain('css/contrast');
      expect(floor?.reason).toContain('src/app.css');
      const text = formatReleaseReport(report);
      expect(text).toContain('oa.gov.release.floor');
      expect(text).toContain('css/contrast');
    } finally {
      await fixture.remove();
    }
  });

  it('reports the same finding for a library, and does not block the release', async () => {
    const fixture = await project({ name: 'some-library', floorFinding: true });
    try {
      const report = await runReleaseCheck(fixture.roots);
      expect(report.scope).toBe('library');
      expect(report.severity).toBe('soft');
      expect(report.exitCode).toBe(0);
      expect(criterionOf(report, 'oa.gov.release.floor')?.verdict).toBe('fail');
      const text = formatReleaseReport(report);
      expect(text).toContain('soft');
      expect(text).toContain('css/contrast');
    } finally {
      await fixture.remove();
    }
  });

  it('reports a criterion nobody answered as unknown, and does not count it as a pass', async () => {
    const fixture = await project({ answered: false });
    try {
      const report = await runReleaseCheck(fixture.roots);
      expect(criterionOf(report, 'oa.ethics.c01')?.verdict).toBe('unknown');
      expect(report.askedFor).toContain('oa.ethics.c01');
      expect(report.counts.pass).toBeLessThan(report.counts.total);
      expect(report.exitCode).not.toBe(0);
    } finally {
      await fixture.remove();
    }
  });

  it('reports a criterion the machine cannot check as unknown', async () => {
    const fixture = await project({ bench: false });
    try {
      const report = await runReleaseCheck(fixture.roots);
      expect(criterionOf(report, 'oa.safety.rc05')?.verdict).toBe('unknown');
      expect(criterionOf(report, 'oa.safety.rc05')?.reason).toContain(
        'benchmark suite has not run',
      );
      expect(report.exitCode).not.toBe(0);
    } finally {
      await fixture.remove();
    }
  });

  it('reads the answer of a person, and the release passes', async () => {
    const fixture = await project({ answered: false });
    try {
      const answered = await runReleaseAnswer(
        fixture.roots.stateRoot,
        'oa.ethics.c01',
        true,
        'the engineer keeps the last word',
      );
      expect(answered.ok).toBe(true);
      expect(answered.count).toBe(1);
      expect(criterionOf(await runReleaseCheck(fixture.roots), 'oa.ethics.c01')?.verdict).toBe(
        'pass',
      );
    } finally {
      await fixture.remove();
    }
  });

  it('refuses an answer for a criterion the framework does not state', async () => {
    const fixture = await project();
    try {
      const answered = await runReleaseAnswer(fixture.roots.stateRoot, 'oa.ethics.c99', true, 'no');
      expect(answered.ok).toBe(false);
      expect(answered.problem).toContain('oa.ethics.c99');
    } finally {
      await fixture.remove();
    }
  });
});
