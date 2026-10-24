import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from './index.js';

let root: string;
let written: string[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openagentsy-cli-'));
  written = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('the CLI', () => {
  it('prints the usage and fails when no command is given', async () => {
    const code = await main([]);
    expect(code).toBe(1);
    expect(written.join('')).toContain('openagentsy <command>');
  });

  it('prints the usage on --help and succeeds', async () => {
    const code = await main(['--help']);
    expect(code).toBe(0);
    expect(written.join('')).toContain('board');
  });

  it('says so when the command is unknown', async () => {
    const code = await main(['nope']);
    expect(code).toBe(1);
  });

  it('shows the board, which is empty on a fresh root', async () => {
    const code = await main(['board', '--root', root]);
    expect(code).toBe(0);
    const output = written.join('');
    expect(output).toContain('records');
    expect(output).toContain('leases');
    expect(output).toContain('budgets');
  });

  it('writes nothing on a dry run of setup', async () => {
    const code = await main(['setup', '--root', root, '--dry-run']);
    expect(code).toBe(0);
    expect(written.join('')).toContain('would write');
  });

  it('leaves the compaction alone by default', async () => {
    // Compaction is off for a memory integration that shrinks the context
    // itself. There is no such integration yet, so a default install that
    // turns compaction off grows a long session without a bound.
    const code = await main(['setup', '--root', root, '--dry-run']);
    expect(code).toBe(0);
    expect(written.join('')).not.toContain('compaction');
  });

  it('turns the compaction off for a memory integration', async () => {
    const code = await main(['setup', '--root', root, '--dry-run', '--magic-context']);
    expect(code).toBe(0);
    expect(written.join('')).toContain('compaction.auto');
  });
});
