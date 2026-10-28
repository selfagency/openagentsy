import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTask, renderTask } from './format.js';

/**
 * The corpus: task files written by Beans, read by this store.
 *
 * The point of the corpus is the bytes. A store that reads its own files
 * proves nothing about a store that reads somebody else's, so the files
 * here were written by the other tool, and the test asks the two questions
 * that matter: does the task survive a round trip, and would the two
 * writers disagree about the file.
 */
const corpus = join(import.meta.dirname, '..', 'fixtures', 'beans-corpus');

/** The task files of the corpus. */
const files = async (): Promise<string[]> =>
  (await readdir(corpus)).filter((name) => name.endsWith('.md')).sort();

describe('the beans corpus', () => {
  it('holds the files it is supposed to hold', async () => {
    const names = await files();
    expect(names.length).toBeGreaterThanOrEqual(10);
  });

  it('parses, renders and parses back to the same task', async () => {
    for (const name of await files()) {
      const original = await readFile(join(corpus, name), 'utf8');
      const task = parseTask(original, name, name);
      const again = parseTask(renderTask(task), name, name);
      expect(again, name).toEqual(task);
    }
  });

  it('renders the bytes beans wrote, and says where it does not', async () => {
    const differences: string[] = [];
    for (const name of await files()) {
      const original = await readFile(join(corpus, name), 'utf8');
      const rendered = renderTask(parseTask(original, name, name));
      if (rendered !== original)
        differences.push(`${name}: ${firstDifference(original, rendered)}`);
    }
    if (differences.length > 0) {
      process.stdout.write(
        `[corpus] ${differences.length} of ${(await files()).length} files render differently:\n${differences.join('\n')}\n`,
      );
    }
    // The claim is strict: the store writes the bytes Beans writes. A
    // difference is a difference in the two writers, and it is printed
    // above so the file that carries it can be looked at.
    expect(differences).toEqual([]);
  });
});

/** The first line where two texts differ. */
const firstDifference = (left: string, right: string): string => {
  const a = left.split('\n');
  const b = right.split('\n');
  for (let line = 0; line < Math.max(a.length, b.length); line++) {
    const first = a[line];
    const second = b[line];
    if (first !== second)
      return `line ${line + 1}: ${JSON.stringify(first)} vs ${JSON.stringify(second)}`;
  }
  return 'the files differ only in their trailing bytes';
};
