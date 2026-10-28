import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { capabilityById } from './capabilities.js';

/**
 * The test the plan asks for (§11).
 *
 * The plan marks the places where an OpenCode API detail was inferred
 * rather than read, and it says that every one of those markers maps to one
 * conformance check. This file holds that map, and it holds it in the
 * open: the markers of the plan are listed one by one, each with the kind
 * it is, the capability that settles it or the check that discharges it,
 * and — for the markers that no longer describe the project — the reason
 * the marker is void.
 *
 * The test fails when the plan grows a marker that is not in the table, so a
 * new VERIFY cannot dangle. The table is not a list of markers the test
 * can live without: every live API marker is held against the registry, and
 * every data and tooling marker is held against a file in the repository
 * that carries the fact.
 */

/** The repository root, resolved from this file and not from the process. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** The plan the markers are read from. */
const PLAN_PATH = join(REPO_ROOT, 'plans', 'PHASE-2-PLAN.md');

/** The text of the plan. */
const PLAN = readFileSync(PLAN_PATH, 'utf8');

/** The kind of a marker. */
type VerifyKind = 'api' | 'data' | 'tooling' | 'void' | 'prose';

/** The kinds of check a marker can be discharged by. */
type Check =
  | { kind: 'contains'; path: string; contains: string }
  | { kind: 'matches'; path: string; pattern: RegExp }
  | { kind: 'pin-agrees' }
  | { kind: 'heading-void'; section: string }
  | { kind: 'no-declares'; name: string }
  | { kind: 'no-caller'; symbol: string; holder: string };

/** One marker of the plan. */
type Entry = {
  /** A piece of the line that holds the marker, and one marker only. */
  quote: string;
  /** What the marker is. */
  kind: VerifyKind;
  /** The capability that settles it, for an API marker. */
  capability?: string;
  /** The section of the plan the marker is in, for an API marker. */
  section?: string;
  /** Why the marker is void. */
  reason?: string;
  /** The check that discharges it, for a data or tooling marker. */
  check?: Check;
  /** The mechanical check that holds the void reason up, for a void marker. */
  voidCheck?: Check;
};

/**
 * Every marker of the plan, one by one.
 *
 * The order is the order of the plan. The quotes are the pieces of the line
 * that hold one marker, so a marker that is added to a line the table
 * already knows is still caught: the test counts the markers and the table
 * has to account for all of them.
 */
const ENTRIES: readonly Entry[] = [
  { quote: 'The v2 facts this plan marked **VERIFY**', kind: 'prose' },
  { quote: "it's marked **VERIFY**", kind: 'prose' },
  { quote: 'every **VERIFY** maps to one conformance check', kind: 'prose' },
  { quote: '`context.keymap.layer` VERIFY', kind: 'prose' },
  { quote: 'Every **VERIFY** on the v2 surface', kind: 'prose' },
  {
    quote: '**VERIFY** the license of `ecologits/data/models.json` before bundling it',
    kind: 'data',
    check: {
      kind: 'contains',
      path: 'packages/footprint/data/SOURCES.md',
      contains: 'license this project has not verified',
    },
  },
  {
    quote: "**VERIFY** whether `@opentui/solid`'s Bun plugin works with `bun build`",
    kind: 'tooling',
    check: {
      kind: 'contains',
      path: 'packages/sidebar/scripts/build.mjs',
      contains: '@opentui/solid/bun-plugin',
    },
  },
  {
    quote: '**VERIFY** the exact pin; turbo reads this field',
    kind: 'tooling',
    check: { kind: 'pin-agrees' },
  },
  {
    quote: 'VERIFY license before bundling',
    kind: 'data',
    check: {
      kind: 'contains',
      path: 'packages/footprint/data/SOURCES.md',
      contains: 'EcoLogits data is not bundled here',
    },
  },
  {
    quote: '**VERIFY** the world-default values and the current provider table',
    kind: 'data',
    check: {
      kind: 'contains',
      path: 'packages/footprint/data/SOURCES.md',
      contains: 'EcoLogits 0.11.3',
    },
  },
  {
    quote: '**VERIFY** both shapes in the Phase 1 adapter',
    kind: 'api',
    capability: 'message-token-fields',
    section: '6.2',
  },
  {
    quote: '**VERIFY** the table schema for the OpenCode version you pin',
    kind: 'api',
    capability: 'opencode-db-schema',
    section: '6.2',
  },
  {
    quote: '// VERIFY panel registration API',
    kind: 'api',
    capability: 'panel-registration',
    section: '7.1',
  },
  {
    quote: 'VERIFY: session.family returns ids or session objects',
    kind: 'api',
    capability: 'session-family',
    section: '7.2',
  },
  {
    quote: '**VERIFY** the prompt-insert API',
    kind: 'api',
    capability: 'prompt-insert',
    section: '7.4',
  },
  {
    quote: '**VERIFY** `context.keymap.layer` → capability `memory-inbox-keymap`',
    kind: 'api',
    capability: 'memory-inbox-keymap',
    section: '7.4',
  },
  {
    quote: 'VERIFY whether the TUI plugin API exposes a KV store',
    kind: 'api',
    capability: 'tui-storage-kv',
    section: '7.5',
  },
  {
    quote: '// VERIFY SDK method shape',
    kind: 'void',
    reason:
      '§7.7 is void by the plan itself: the project speaks OpenCode 2 only, so there is no V1 runtime and no toast to fire on session.idle.',
    voidCheck: { kind: 'heading-void', section: '7.7' },
  },
  {
    quote: 'VERIFY: hooks are exported from the package root',
    kind: 'void',
    reason:
      'The package the marker asks about is not a dependency of this project: @agentsy/runtime is not on npm, so the registry is local and there is no upstream export to settle.',
    voidCheck: { kind: 'no-declares', name: '@agentsy/runtime' },
  },
  {
    quote: '**VERIFY** that changes made in the `config` hook reach the permission evaluator',
    kind: 'void',
    reason:
      'The hook the marker asks about has no home on the runtime the project supports: the 2.x context has no config domain, and the approval is asked through the permission hook.',
    voidCheck: {
      kind: 'contains',
      path: 'packages/adapter-opencode/src/v2.ts',
      contains: '`config` has no domain',
    },
  },
  {
    quote: "**VERIFY** the hook's write contract on the pinned version",
    kind: 'void',
    reason:
      'The compaction job exists but nothing calls it: the marker names the V1 hook experimental.session.compacting, and no runtime of the project registers it, so the write contract has no host to settle it.',
    voidCheck: {
      kind: 'no-caller',
      symbol: 'compactionSummary',
      holder: 'packages/offload/src/jobs.ts',
    },
  },
  { quote: 'spec anchor of the VERIFY it settles', kind: 'prose' },
  { quote: 'one entry per remaining VERIFY in this spec', kind: 'prose' },
  { quote: 'OpenCode-API VERIFY needs a check', kind: 'prose' },
  { quote: 'greps this spec for **VERIFY**', kind: 'prose' },
  { quote: 'Nothing marked VERIFY is allowed to dangle', kind: 'prose' },
  { quote: 'Every **VERIFY** in the spec maps to a conformance check', kind: 'prose' },
  { quote: 'VERIFY → capability `session-family`', kind: 'prose' },
];

/** One marker of the plan, with where it is. */
type Marker = {
  /** The offset of the marker in the plan. */
  offset: number;
  /** The line the marker is on. */
  line: number;
  /** The section of the plan the marker is in. */
  section: string | undefined;
};

/** The headings of the plan, with the offset they are at. */
function headings(): { offset: number; number: string | undefined; text: string }[] {
  const found: { offset: number; number: string | undefined; text: string }[] = [];
  let offset = 0;
  let inFence = false;
  for (const line of PLAN.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) inFence = !inFence;
    if (!inFence && /^#{2,3}\s/.test(line)) {
      const numbered = /^#{2,3}\s+(\d+(?:\.\d+)?)\b/.exec(line);
      found.push({ offset, number: numbered?.[1], text: line });
    }
    offset += line.length + 1;
  }
  return found;
}

/** The headings of the plan. */
const HEADINGS = headings();

/** The section an offset is in. */
function sectionOf(offset: number): string | undefined {
  let current: string | undefined;
  for (const heading of HEADINGS) {
    if (heading.offset > offset) break;
    current = heading.number;
  }
  return current;
}

/** Every marker of the plan, in the order they appear. */
function markers(): Marker[] {
  const found: Marker[] = [];
  const pattern = /\bVERIFY\b/g;
  for (;;) {
    const match = pattern.exec(PLAN);
    if (match === null) break;
    const offset = match.index;
    const line = PLAN.slice(0, offset).split('\n').length;
    found.push({ offset, line, section: sectionOf(offset) });
  }
  return found;
}

/** Every marker of the plan. */
const MARKERS = markers();

/** The offset of a quote in the plan, and the offset of the marker in it. */
function locate(quote: string): { quote: number; marker: number } | undefined {
  const quoteOffset = PLAN.indexOf(quote);
  if (quoteOffset === -1) return undefined;
  const inside = quote.search(/\bVERIFY\b/);
  if (inside === -1) return undefined;
  return { quote: quoteOffset, marker: quoteOffset + inside };
}

/** The source files of the workspace. */
function sourceFiles(): string[] {
  const packages = readdirSync(join(REPO_ROOT, 'packages'));
  const found: string[] = [];
  for (const name of packages) {
    const directory = join(REPO_ROOT, 'packages', name, 'src');
    if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) continue;
    found.push(...walk(directory));
  }
  return found;
}

/** Every file under a directory. */
function walk(directory: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      found.push(...walk(path));
      continue;
    }
    if (path.endsWith('.ts') || path.endsWith('.tsx')) found.push(path);
  }
  return found;
}

/** The package manifests of the workspace. */
function manifests(): string[] {
  const packages = readdirSync(join(REPO_ROOT, 'packages'));
  const found = [join(REPO_ROOT, 'package.json')];
  for (const name of packages) {
    found.push(join(REPO_ROOT, 'packages', name, 'package.json'));
  }
  return found;
}

/** Whether a file of the repository says the thing the check names. */
function holdsContains(check: { path: string; contains: string }): boolean {
  const text = readFileSync(join(REPO_ROOT, check.path), 'utf8');
  return text.includes(check.contains);
}

/** Whether a file of the repository matches the pattern the check names. */
function holdsMatches(check: { path: string; pattern: RegExp }): boolean {
  const text = readFileSync(join(REPO_ROOT, check.path), 'utf8');
  return check.pattern.test(text);
}

/** Whether the package manager pin and the version file name one version. */
function holdsPinAgrees(): boolean {
  const manifest = readFileSync(join(REPO_ROOT, 'package.json'), 'utf8');
  const pinned = /"packageManager":\s*"bun@(\d+\.\d+\.\d+)"/.exec(manifest);
  const version = readFileSync(join(REPO_ROOT, '.bun-version'), 'utf8').trim();
  return pinned !== null && pinned[1] === version;
}

/** Whether the section of the plan is one the plan calls void. */
function holdsHeadingVoid(check: { section: string }): boolean {
  const heading = HEADINGS.find((candidate) => candidate.number === check.section);
  return heading !== undefined && heading.text.includes('void');
}

/** Whether no manifest of the workspace declares the package. */
function holdsNoDeclares(check: { name: string }): boolean {
  for (const path of manifests()) {
    if (readFileSync(path, 'utf8').includes(check.name)) return false;
  }
  return true;
}

/** Whether no source file of the workspace calls the symbol. */
function holdsNoCaller(check: { symbol: string; holder: string }): boolean {
  for (const path of sourceFiles()) {
    if (path.endsWith(check.holder)) continue;
    if (path.endsWith('.test.ts')) continue;
    if (readFileSync(path, 'utf8').includes(check.symbol)) return false;
  }
  return true;
}

/** Whether a check holds. */
function holds(check: Check): boolean {
  switch (check.kind) {
    case 'contains':
      return holdsContains(check);
    case 'matches':
      return holdsMatches(check);
    case 'pin-agrees':
      return holdsPinAgrees();
    case 'heading-void':
      return holdsHeadingVoid(check);
    case 'no-declares':
      return holdsNoDeclares(check);
    case 'no-caller':
      return holdsNoCaller(check);
  }
}

describe('the VERIFY markers of the plan', () => {
  it('finds every marker of the plan', () => {
    // The count is pinned, so a marker that is added to the plan and a
    // marker that is taken out of it both stop the test.
    expect(MARKERS.length).toBe(28);
  });

  it('accounts for every marker, and accounts for each one once', () => {
    const claimed = new Map<number, string>();
    for (const entry of ENTRIES) {
      const found = locate(entry.quote);
      expect(found, `the quote is not in the plan: ${entry.quote}`).toBeDefined();
      if (found === undefined) continue;
      expect(claimed.has(found.marker), `two entries claim the same marker: ${entry.quote}`).toBe(
        false,
      );
      claimed.set(found.marker, entry.quote);
    }
    const missed = MARKERS.filter((marker) => !claimed.has(marker.offset));
    expect(
      missed.map((marker) => `line ${marker.line}`),
      'a VERIFY of the plan is not accounted for',
    ).toEqual([]);
  });

  it('holds every live API marker against the registry', () => {
    for (const entry of ENTRIES) {
      if (entry.kind !== 'api') continue;
      const capability = capabilityById(entry.capability ?? '');
      expect(
        capability,
        `the capability is not in the registry: ${entry.capability}`,
      ).toBeDefined();
      expect(
        capability?.verifyRef,
        `the capability does not settle the section of the marker: ${entry.capability}`,
      ).toBe(`§${entry.section}`);
    }
  });

  it('puts every API marker in the section the registry claims', () => {
    for (const entry of ENTRIES) {
      if (entry.kind !== 'api') continue;
      const found = locate(entry.quote);
      expect(found).toBeDefined();
      if (found === undefined) continue;
      expect(sectionOf(found.marker)).toBe(entry.section);
    }
  });

  it('discharges every data and tooling marker with a named check', () => {
    for (const entry of ENTRIES) {
      if (entry.kind !== 'data' && entry.kind !== 'tooling') continue;
      expect(entry.check, `the marker has no check: ${entry.quote}`).toBeDefined();
      if (entry.check === undefined) continue;
      expect(holds(entry.check), `the check does not hold: ${entry.quote}`).toBe(true);
    }
  });

  it('holds the void reason of every void marker up', () => {
    for (const entry of ENTRIES) {
      if (entry.kind !== 'void') continue;
      expect(entry.reason, `the void marker has no reason: ${entry.quote}`).toBeDefined();
      expect(entry.voidCheck, `the void marker has no check: ${entry.quote}`).toBeDefined();
      if (entry.voidCheck === undefined) continue;
      expect(holds(entry.voidCheck), `the void reason does not hold: ${entry.quote}`).toBe(true);
    }
  });
});
