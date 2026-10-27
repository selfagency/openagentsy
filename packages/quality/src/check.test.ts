import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { check } from './check.js';
import { allRegistry } from './rules.js';

/** A directory the test writes into. */
async function scratch(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'openagentsy-quality-check-'));
}

describe('the check of a set of paths', () => {
  it('runs the rules that apply to a file and names the file', async () => {
    const root = await scratch();
    await writeFile(join(root, 'app.css'), '.a { transition: all 0.2s; }\n', 'utf8');

    const findings = await check(['app.css'], {}, { root });

    expect(findings.map((finding) => finding.ruleId)).toContain('css/no-transition-all');
    expect(findings[0]?.file).toBe('app.css');
    expect(findings[0]?.line).toBe(1);
  });

  it('says nothing about a file that is not there', async () => {
    const root = await scratch();

    const findings = await check(['gone.css'], {}, { root });

    expect(findings).toEqual([]);
  });

  it('says nothing about a file no rule applies to', async () => {
    const root = await scratch();
    await writeFile(join(root, 'plan.md'), '# A plan\n', 'utf8');

    const findings = await check(['plan.md'], {}, { root });

    expect(findings).toEqual([]);
  });

  it('finds the claim of a page and holds it to the floor', async () => {
    const root = await scratch();
    await writeFile(join(root, 'page.html'), '<p>Save 50% today</p>\n', 'utf8');

    const findings = await check(['page.html'], {}, { root });

    const claim = findings.find((finding) => finding.ruleId === 'copy/unsourced-claim');
    expect(claim?.tier).toBe('floor');
    expect(claim?.file).toBe('page.html');
  });

  it('checks every path it is given', async () => {
    const root = await scratch();
    await writeFile(join(root, 'one.css'), '.a { transition: all 0.2s; }\n', 'utf8');
    await writeFile(join(root, 'two.css'), '.b { transition: all 0.2s; }\n', 'utf8');

    const findings = await check(['one.css', 'two.css'], {}, { root });

    expect(new Set(findings.map((finding) => finding.file))).toEqual(
      new Set(['one.css', 'two.css']),
    );
  });

  it('runs the rules that need no compiler, and not the comment rules', async () => {
    const root = await scratch();
    await writeFile(
      join(root, 'app.ts'),
      '// Step 1: trim the input\nexport const a = 1;\n',
      'utf8',
    );

    const findings = await check(['app.ts'], {}, { root });

    expect(findings.some((finding) => finding.ruleId.startsWith('comment/'))).toBe(false);
  });

  it('runs the comment rules when the full registry is asked for', async () => {
    const root = await scratch();
    await writeFile(
      join(root, 'app.ts'),
      '// Step 1: trim the input\nexport const a = 1;\n',
      'utf8',
    );

    const findings = await check(['app.ts'], {}, { root, registry: allRegistry });

    const step = findings.find((finding) => finding.ruleId === 'comment/step-narration');
    expect(step?.file).toBe('app.ts');
    expect(step?.line).toBe(1);
  });

  it('reads the design file as data, so a taste rule can be turned off', async () => {
    const root = await scratch();
    await writeFile(join(root, 'page.html'), '<p>Hello — world</p>\n', 'utf8');
    const config = { enable: ['copy/em-dash'] };

    const without = await check(['page.html'], { config }, { root });
    const with_ = await check(['page.html'], { config, design: 'copy/em-dash is off' }, { root });

    expect(without.some((finding) => finding.ruleId === 'copy/em-dash')).toBe(true);
    expect(with_.some((finding) => finding.ruleId === 'copy/em-dash')).toBe(false);
  });
});
