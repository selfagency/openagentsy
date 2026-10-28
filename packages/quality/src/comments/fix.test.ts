import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SourceFile } from '../rule.js';
import { astEqualIgnoringComments, parseFile } from './ast.js';
import { applyCommentFix, type CommentFix, commentFixes } from './fix.js';
import { commentRules } from './rules.js';

function fixture(ruleId: string, kind: 'pass' | 'fail'): SourceFile {
  const name = ruleId.replace('comment/', '');
  const url = new URL(`../../fixtures/comments/${name}/${kind}.ts`, import.meta.url);
  return { path: fileURLToPath(url), text: readFileSync(url, 'utf8') };
}

function ruleOf(id: string) {
  const found = commentRules.find((rule) => rule.id === id);
  if (found === undefined) throw new Error(`the rule ${id} is missing`);
  return found;
}

/** The fix of a file, or a failure that says there was none. */
function firstFix(file: SourceFile): CommentFix {
  const fix = commentFixes(file)[0];
  if (fix === undefined) throw new Error('the fixture has no fix');
  return fix;
}

describe('the comment fixes', () => {
  it('takes the comment out and leaves the code the same', () => {
    const file = fixture('comment/banner-separator', 'fail');
    const fix = firstFix(file);

    const out = applyCommentFix(file.text, fix);

    expect(out).not.toContain('==================');
    expect(out).toContain('export function total');
    expect(
      astEqualIgnoringComments(parseFile(file.text, file.path), parseFile(out, file.path)),
    ).toBe(true);
  });

  it('refuses a fix that changes the code', () => {
    const fix: CommentFix = {
      ruleId: 'comment/banner-separator',
      path: '/tmp/demo.ts',
      range: { start: 10, end: 13 },
      replacement: 'y',
      instruction: 'break the code',
    };

    expect(() => applyCommentFix('const a = "x";\n', fix)).toThrow(
      'comment fix comment/banner-separator changed code',
    );
  });

  it('takes more than one fix from the last to the first', () => {
    const file = fixture('comment/banner-separator', 'fail');
    const fixes = commentFixes(file);

    expect(fixes).toHaveLength(2);

    let out = file.text;
    for (const fix of [...fixes].reverse()) out = applyCommentFix(out, fix);

    expect(out).not.toContain('==================');
    expect(out).not.toContain('MAIN LOGIC');
    expect(
      astEqualIgnoringComments(parseFile(file.text, file.path), parseFile(out, file.path)),
    ).toBe(true);
  });

  it('needs that order, because a fix moves the offsets of the ones after it', () => {
    const file = fixture('comment/banner-separator', 'fail');
    const fixes = commentFixes(file);
    const first = firstFix(file);
    const second = fixes[1];
    if (second === undefined) throw new Error('the fixture has one fix too few');

    const out = applyCommentFix(file.text, first);

    expect(() => applyCommentFix(out, second)).toThrow('changed code');
  });

  it('gives the empty TODO an instruction and no rewrite', () => {
    const file = fixture('comment/empty-todo', 'fail');
    const findings = ruleOf('comment/empty-todo').check(file, {});

    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]?.fix).toContain('Name the task');
    expect(commentFixes(file)).toEqual([]);
  });
});

describe('the AST comparison', () => {
  it('sees the same program when only the comments differ', () => {
    const a = parseFile('const s = 1; // one\n', '/tmp/a.ts');
    const b = parseFile('const s = 1; // two\n', '/tmp/b.ts');

    expect(astEqualIgnoringComments(a, b)).toBe(true);
  });

  it('sees a changed string literal', () => {
    const a = parseFile('const s = "x";\n', '/tmp/a.ts');
    const b = parseFile('const s = "xy";\n', '/tmp/b.ts');

    expect(astEqualIgnoringComments(a, b)).toBe(false);
  });

  it('sees a changed operator', () => {
    const a = parseFile('const s = a + b;\n', '/tmp/a.ts');
    const b = parseFile('const s = a - b;\n', '/tmp/b.ts');

    expect(astEqualIgnoringComments(a, b)).toBe(false);
  });

  it('sees a changed name', () => {
    const a = parseFile('const s = add(a, b);\n', '/tmp/a.ts');
    const b = parseFile('const s = add(a, c);\n', '/tmp/b.ts');

    expect(astEqualIgnoringComments(a, b)).toBe(false);
  });
});
