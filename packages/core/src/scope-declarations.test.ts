import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { validateScopeBlock } from './scope/block.js';
import { parseScopeBlocks } from './scope/declarations-file.js';

/**
 * The declarations file and the declarations it comes from.
 *
 * `src/scope/declarations.ts` is the source of truth: it carries the
 * declarations, the review material and the reason every entry is there.
 * `src/scope-declarations.yaml` is generated from it, and it is what the
 * package reads at runtime and what a person pastes into `roles.yaml`.
 *
 * The test runs the generator and compares what it writes with the file the
 * repository ships. A file that was edited by hand, or a declaration that
 * was changed without running the generator, is a drift, and the drift is
 * reported with the role and the field that differ.
 */
const GENERATOR = fileURLToPath(
  new URL('../scripts/generate-scope-declarations.mjs', import.meta.url),
);
const DECLARATIONS = fileURLToPath(new URL('./scope-declarations.yaml', import.meta.url));

/** The fields a block carries, in the order the file writes them. */
const FIELDS = ['purpose', 'in_scope', 'out_of_scope', 'refusal_pattern', 'redirect'] as const;

/**
 * The file the generator writes.
 *
 * The generator is run with `--out`, so the test never writes over the file
 * the repository ships.
 */
function generate(): string {
  const dir = mkdtempSync(join(tmpdir(), 'oa-scope-declarations-'));
  try {
    const out = join(dir, 'scope-declarations.yaml');
    execFileSync('bun', [GENERATOR, '--out', out], { encoding: 'utf8' });
    return readFileSync(out, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The blocks of a declarations file, as a map of role to block. */
function blocksOf(text: string): Record<string, Record<string, unknown>> {
  const parsed: unknown = parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const blocks: Record<string, Record<string, unknown>> = {};
  for (const [role, block] of Object.entries(parsed)) {
    if (typeof block !== 'object' || block === null || Array.isArray(block)) continue;
    blocks[role] = block as Record<string, unknown>;
  }
  return blocks;
}

/**
 * What differs in one field.
 *
 * A list is compared entry by entry, so a list that lost an entry names the
 * index it lost. A text is compared as a whole.
 */
function fieldDifferences(
  role: string,
  field: string,
  expected: unknown,
  actual: unknown,
): string[] {
  if (Array.isArray(expected) || Array.isArray(actual)) {
    const from = Array.isArray(expected) ? expected : [];
    const to = Array.isArray(actual) ? actual : [];
    const problems: string[] = [];
    const length = Math.max(from.length, to.length);
    for (let index = 0; index < length; index += 1) {
      const a = from[index];
      const b = to[index];
      if (a === b) continue;
      problems.push(
        `${role}.${field}[${index}]: the file says ${JSON.stringify(a)} and the declarations say ${JSON.stringify(b)}`,
      );
    }
    return problems;
  }
  if (expected === actual) return [];
  return [
    `${role}.${field}: the file says ${JSON.stringify(expected)} and the declarations say ${JSON.stringify(actual)}`,
  ];
}

/**
 * What differs in one role.
 *
 * A role that is in one file and not the other is a difference of its own,
 * and it is reported before the fields are compared.
 */
function roleDifferences(
  role: string,
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): string[] {
  if (before === undefined) {
    return [`${role}: the declarations have the role and the file does not`];
  }
  if (after === undefined) {
    return [`${role}: the file has the role and the declarations do not`];
  }
  const problems: string[] = [];
  for (const field of FIELDS) {
    problems.push(...fieldDifferences(role, field, before[field], after[field]));
  }
  return problems;
}

/**
 * What differs between the file the repository ships and the file the
 * generator writes.
 *
 * The report names the role and the field, so the person who has to fix it
 * does not have to read two files to find the one line that moved.
 */
function differences(shipped: string, generated: string): string[] {
  const before = blocksOf(shipped);
  const after = blocksOf(generated);
  const roles = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const problems: string[] = [];
  for (const role of roles) {
    problems.push(...roleDifferences(role, before[role], after[role]));
  }
  return problems;
}

describe('the scope declarations file', () => {
  it('is what the generator writes from the declarations', () => {
    const shipped = readFileSync(DECLARATIONS, 'utf8');
    const generated = generate();
    expect(differences(shipped, generated)).toEqual([]);
    expect(shipped).toBe(generated);
  });

  it('is written the same way every time', () => {
    expect(generate()).toBe(generate());
  });

  it('says that it is generated, and by which script', () => {
    const shipped = readFileSync(DECLARATIONS, 'utf8');
    expect(shipped).toContain('GENERATED FILE');
    expect(shipped).toContain('scripts/generate-scope-declarations.mjs');
  });

  it('holds a block every role can validate', () => {
    const blocks = parseScopeBlocks(generate());
    for (const [role, block] of Object.entries(blocks)) {
      expect(validateScopeBlock(block), `${role} does not validate`).toEqual([]);
    }
  });
});
