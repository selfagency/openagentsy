import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanComments } from './scanner.js';

/** A fixture of the scanner, with the text of the file. */
function fixture(name: string): { path: string; text: string } {
  const url = new URL(`../../fixtures/comments/scanner/${name}`, import.meta.url);
  return { path: fileURLToPath(url), text: readFileSync(url, 'utf8') };
}

describe('the comment scan', () => {
  it('reads the comments of a file with the compiler ranges', () => {
    const file = fixture('sample.ts');
    const scan = scanComments(file.text, file.path);

    expect(scan.comments.map((comment) => comment.text.trim())).toEqual([
      'The first comment.',
      'A comment that hangs before the closing brace.',
    ]);
  });

  it('gives the offsets of every comment', () => {
    const file = fixture('sample.ts');
    const scan = scanComments(file.text, file.path);

    for (const comment of scan.comments) {
      expect(file.text.slice(comment.start, comment.end)).toContain(comment.text.trim());
    }
  });

  it('counts the lines from one', () => {
    const file = fixture('sample.ts');
    const scan = scanComments(file.text, file.path);

    expect(scan.comments.map((comment) => comment.line)).toEqual([1, 4]);
  });

  it('finds a comment that hangs before a closing brace', () => {
    const file = fixture('sample.ts');
    const scan = scanComments(file.text, file.path);

    const hanging = scan.comments[1];

    expect(hanging?.line).toBe(4);
    expect(hanging?.text).toContain('hangs before the closing brace');
  });

  it('does not read a comment inside a string as a comment', () => {
    const file = fixture('sample.ts');
    const scan = scanComments(file.text, file.path);

    expect(file.text).toContain("'a//b'");
    expect(scan.comments.some((comment) => comment.text.includes('a//b'))).toBe(false);
  });

  it('does not read a URL inside a JSX text as a comment', () => {
    const file = fixture('sample.tsx');
    const scan = scanComments(file.text, file.path);

    expect(file.text).toContain('//page');
    expect(scan.comments.some((comment) => comment.text.includes('page'))).toBe(false);
    expect(scan.comments.map((comment) => comment.line)).toEqual([1, 3]);
  });

  it('tells a block comment from a line comment', () => {
    const file = fixture('sample.ts');
    const scan = scanComments(file.text, file.path);

    expect(scan.comments.every((comment) => !comment.block)).toBe(true);
    expect(scan.comments.every((comment) => !comment.jsDoc)).toBe(true);
  });
});
