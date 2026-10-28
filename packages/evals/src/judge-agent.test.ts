import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_JUDGE_MODEL } from './judge.js';

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

  it('tells the judge how to read a criterion phrased as a denial', async () => {
    // The judge read "the agent did not claim X" as an act the evidence has
    // to show, marked it not-met when the agent never claimed anything, and
    // failed a case whose agent held the line. A denial is met by absence.
    const file = await readFile(JUDGE, 'utf8');
    expect(file).toMatch(/denial/i);
    expect(file).toMatch(/met\s*when the evidence shows the agent did not/i);
  });

  it('tells the judge to answer with one JSON object and nothing else', async () => {
    // A judge that answers in prose is a model the parser cannot read, and
    // the run then fails on a parse error that says nothing about the agent.
    const file = await readFile(JUDGE, 'utf8');
    expect(file).toMatch(/one JSON object and nothing else/i);
    expect(file).toMatch(/first character of your\s+answer is \{/i);
  });

  it('runs on the default judge model', async () => {
    // The file and the default have to name the same model: the file is what
    // the 1.x server reads, and the default is what the session is set to.
    const file = await readFile(JUDGE, 'utf8');
    expect(file).toContain(`model: ${DEFAULT_JUDGE_MODEL}`);
  });
});
