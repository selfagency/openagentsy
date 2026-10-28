import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../index.js';
import { formatScope, runScope } from './scope.js';

/** The seven first-party roles. */
const ROLES = ['lead', 'scout', 'researcher', 'builder', 'reviewer', 'advisor', 'archivist'];

/** What a command wrote, on either stream. */
let written: string[];
let writtenErrors: string[];

afterEach(() => {
  vi.restoreAllMocks();
  written = [];
  writtenErrors = [];
});

/** Watch both streams of the process. */
function watchOutput(): void {
  written = [];
  writtenErrors = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    writtenErrors.push(String(chunk));
    return true;
  });
}

describe('the scope command', () => {
  it('prints the declaration of one role', () => {
    const report = runScope('builder');
    expect(report.declarations).toHaveLength(1);
    expect(report.declarations[0]?.role).toBe('builder');
    const text = formatScope(report);
    expect(text).toContain('builder (Builder):');
    expect(text).toContain('Purpose:');
    expect(text).toContain('In scope:');
    expect(text).toContain('Out of scope:');
    expect(text).toContain('Refusal:');
    expect(text).toContain('Redirect:');
  });

  it('prints every declaration when no role is named', () => {
    const report = runScope();
    expect(report.declarations.map((declaration) => declaration.role)).toEqual(ROLES);
    const text = formatScope(report);
    for (const role of ROLES) {
      expect(text).toContain(`${role} (`);
    }
  });

  it('says that a declaration is a proposal until two maintainers reviewed it', () => {
    const text = formatScope(runScope('builder'));
    expect(text).toContain('Review: proposed');
    expect(text).toContain('0 of 2 maintainers');
  });

  it('reaches a role by its agent id and by the Lead agent name', () => {
    expect(runScope('oa-builder').declarations[0]?.role).toBe('builder');
    expect(runScope('agentsy').declarations[0]?.role).toBe('lead');
  });

  it('says so when the role has no declaration', () => {
    const report = runScope('offload');
    expect(report.declarations).toHaveLength(0);
    expect(report.unknownRole).toBe('offload');
    const text = formatScope(report);
    expect(text).toContain('no scope declaration for offload');
    expect(text).toContain('the roles that have one');
  });
});

describe('oa scope, through the CLI', () => {
  it('prints the declaration of the role that was named', async () => {
    watchOutput();
    const code = await main(['scope', 'builder']);
    expect(code).toBe(0);
    const output = written.join('');
    expect(output).toContain('builder (Builder):');
    expect(output).toContain('Implementing the assigned bean');
    expect(output).not.toContain('lead (Lead):');
  });

  it('prints every declaration when no role is named', async () => {
    watchOutput();
    const code = await main(['scope']);
    expect(code).toBe(0);
    const output = written.join('');
    for (const role of ROLES) {
      expect(output).toContain(`${role} (`);
    }
  });

  it('fails and says so when the role has no declaration', async () => {
    watchOutput();
    const code = await main(['scope', 'offload']);
    expect(code).toBe(1);
    expect(writtenErrors.join('')).toContain('no scope declaration for offload');
  });

  it('is named in the usage card', async () => {
    watchOutput();
    const code = await main(['--help']);
    expect(code).toBe(0);
    expect(written.join('')).toContain('scope [role]');
  });
});
