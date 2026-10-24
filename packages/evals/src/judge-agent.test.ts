import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const JUDGE = join(import.meta.dirname, '..', 'templates', 'judge.md');

describe('the judge agent', () => {
  it('is told to judge the message it is given', async () => {
    // The judge burned all its steps looking for the agent's transcript on
    // disk, and answered with prose instead of a verdict. The message
    // carries the criteria, the conversation and the state: the file has to
    // say so, or the model goes looking for them.
    const file = await readFile(JUDGE, 'utf8');
    expect(file).toMatch(/message carries/i);
    expect(file).toMatch(/conversation/i);
    expect(file).toMatch(/state/i);
  });

  it('does not deny the read tool', async () => {
    // A permission that denies the read tool is the one shape the Console's
    // free tier refuses, so the judge would never answer. The judge is told
    // not to read instead.
    const file = await readFile(JUDGE, 'utf8');
    expect(file).not.toMatch(/^\s*read:\s*deny\s*$/m);
  });
});
