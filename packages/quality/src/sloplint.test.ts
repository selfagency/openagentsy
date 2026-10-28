import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type ChildRequest,
  type ChildRunner,
  findSloplint,
  parseSloplint,
  pickEnv,
  renderSupport,
  runSloplint,
  SLOPLINT_ENV,
  skillRoots,
} from './sloplint.js';

/** The linter the fixture stands for: one line of every tier. */
const FIXTURE = [
  "console.log('FAIL page.html:3 — the heading is a placeholder');",
  "console.log('REFLEX page.html:9 — a gradient that says nothing');",
  "console.log('WARN page.html:12 — the spacing is a guess');",
  '',
].join('\n');

/** A linter that fails without saying why. */
const CRASHING = "throw new Error('the linter is broken');\n";

/** A linter that says something the bridge cannot read. */
const CHATTING = "console.log('everything looks fine to me');\n";

/** A linter that never comes back. */
const HANGING = 'await new Promise(() => {});\n';

/** A directory the test writes into. */
async function scratch(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'openagentsy-sloplint-'));
}

/**
 * A project with a linter in it.
 *
 * The script stands where Hallmark puts it, so the bridge finds it the way
 * it finds the real one.
 */
async function projectWith(script: string): Promise<string> {
  const root = await scratch();
  const dir = join(root, 'skills', 'hallmark', 'scripts');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'sloplint.mjs'), script, 'utf8');
  await writeFile(join(root, 'page.html'), '<p>Hello.</p>\n', 'utf8');
  await writeFile(join(root, 'app.css'), '.a { color: red; }\n', 'utf8');
  return root;
}

/** A runner that records what it was asked to do. */
function recorder(requests: ChildRequest[], outcome: Partial<ChildRequest> = {}): ChildRunner {
  return async (request) => {
    requests.push(request);
    return { code: 0, stdout: '', stderr: '', timedOut: false, ...outcome };
  };
}

describe('the sloplint bridge', () => {
  it('finds the script in the project and runs it', async () => {
    const root = await projectWith(FIXTURE);

    const result = await runSloplint({ root, files: ['page.html'] });

    expect(result.path).toBe('static+sloplint');
    expect(result.findings).toHaveLength(3);
    expect(result.script).toBe(join(root, 'skills', 'hallmark', 'scripts', 'sloplint.mjs'));
  });

  it('parses the output of the linter into findings', async () => {
    const root = await projectWith(FIXTURE);

    const result = await runSloplint({ root, files: ['page.html'] });
    const first = result.findings[0];

    expect(first?.file).toBe('page.html');
    expect(first?.line).toBe(3);
    expect(first?.message).toBe('the heading is a placeholder');
    expect(first?.source).toBe('hallmark');
  });

  it('maps a fail to the floor, a reflex to a reflex and a warn to a finish', async () => {
    const root = await projectWith(FIXTURE);

    const result = await runSloplint({ root, files: ['page.html'] });

    expect(result.findings.map((finding) => finding.tier)).toEqual(['floor', 'reflex', 'finish']);
  });

  it('degrades to the static path when the script is not installed', async () => {
    const root = await scratch();
    await writeFile(join(root, 'page.html'), '<p>Hello.</p>\n', 'utf8');

    const result = await runSloplint({ root, files: ['page.html'], home: await scratch() });

    expect(result.path).toBe('static');
    expect(result.degraded).toBe('absent');
    expect(result.findings).toEqual([]);
  });

  it('degrades to the static path when the linter crashes', async () => {
    const root = await projectWith(CRASHING);

    const result = await runSloplint({ root, files: ['page.html'] });

    expect(result.path).toBe('static');
    expect(result.degraded).toBe('crashed');
    expect(result.findings).toEqual([]);
  });

  it('degrades to the static path when the linter runs too long', async () => {
    const root = await projectWith(HANGING);

    const result = await runSloplint({ root, files: ['page.html'], timeoutMs: 250 });

    expect(result.path).toBe('static');
    expect(result.degraded).toBe('timeout');
    expect(result.findings).toEqual([]);
  });

  it('degrades to the static path when the output cannot be read', async () => {
    const root = await projectWith(CHATTING);

    const result = await runSloplint({ root, files: ['page.html'] });

    expect(result.path).toBe('static');
    expect(result.degraded).toBe('unparsable');
  });

  it('gives the child no Together key, though the linter calls an API', async () => {
    const root = await projectWith(
      "console.log('FAIL page.html:1 — key=' + (process.env.TOGETHER_API_KEY ?? 'none'));\n",
    );

    const result = await runSloplint({
      root,
      files: ['page.html'],
      env: { ...process.env, TOGETHER_API_KEY: 'a-secret' },
    });

    expect(result.findings[0]?.message).toBe('key=none');
  });

  it('gives the child a restricted environment and never a shell', async () => {
    const requests: ChildRequest[] = [];
    const root = await projectWith(FIXTURE);
    const env = { ...process.env, TOGETHER_API_KEY: 'a-secret', OPENAI_API_KEY: 'another-secret' };

    await runSloplint({ root, files: ['page.html'], env, run: recorder(requests) });

    const request = requests[0];
    expect(request?.shell).toBe(false);
    expect(request?.env.TOGETHER_API_KEY).toBeUndefined();
    expect(request?.env.OPENAI_API_KEY).toBeUndefined();
    expect(request?.env).toEqual(pickEnv(env));
    const allowed = SLOPLINT_ENV as readonly string[];
    expect(Object.keys(request?.env ?? {}).every((key) => allowed.includes(key))).toBe(true);
  });

  it('runs the linter on the pages and the stylesheets, and on nothing else', async () => {
    const requests: ChildRequest[] = [];
    const root = await projectWith(FIXTURE);

    await runSloplint({
      root,
      files: ['page.html', 'app.css', 'src/app.ts', 'README.md'],
      run: recorder(requests),
    });

    expect(requests[0]?.args.slice(1)).toEqual(['page.html', 'app.css']);
  });

  it('does not use the render mode when the browser is not there, and says so', async () => {
    const requests: ChildRequest[] = [];
    const root = await projectWith(FIXTURE);

    const result = await runSloplint({
      root,
      files: ['page.html'],
      render: { puppeteer: false, chrome: true, canRender: false },
      run: recorder(requests),
    });

    expect(requests[0]?.args).not.toContain('--render');
    expect(result.path).toBe('static+sloplint');
    expect(result.renderSupport.canRender).toBe(false);
  });

  it('uses the render mode when the browser is there', async () => {
    const requests: ChildRequest[] = [];
    const root = await projectWith(FIXTURE);

    const result = await runSloplint({
      root,
      files: ['page.html'],
      render: { puppeteer: true, chrome: true, canRender: true },
      run: recorder(requests),
    });

    expect(requests[0]?.args).toContain('--render');
    expect(result.path).toBe('static+sloplint-render');
  });

  it('finds the script in the home directory as well', async () => {
    const home = await scratch();
    const dir = join(home, '.agents', 'skills', 'hallmark', 'scripts');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'sloplint.mjs'), FIXTURE, 'utf8');
    const root = await scratch();
    await writeFile(join(root, 'page.html'), '<p>Hello.</p>\n', 'utf8');

    const result = await runSloplint({ root, files: ['page.html'], home });

    expect(result.path).toBe('static+sloplint');
    expect(result.findings).toHaveLength(3);
  });
});

describe('the lines of the linter', () => {
  it('reads a line that names a file and a line', () => {
    const findings = parseSloplint('FAIL src/page.html:12 — the heading is a placeholder');

    expect(findings[0]?.file).toBe('src/page.html');
    expect(findings[0]?.line).toBe(12);
    expect(findings[0]?.message).toBe('the heading is a placeholder');
    expect(findings[0]?.ruleId).toBe('hallmark/sloplint-fail');
  });

  it('reads a line that names a file and no line', () => {
    const findings = parseSloplint('REFLEX src/app.css — a gradient that says nothing');

    expect(findings[0]?.file).toBe('src/app.css');
    expect(findings[0]?.line).toBe(0);
    expect(findings[0]?.tier).toBe('reflex');
  });

  it('reads a line that names neither a file nor a line', () => {
    const findings = parseSloplint('WARN: the spacing is a guess');

    expect(findings[0]?.file).toBe('');
    expect(findings[0]?.line).toBe(0);
    expect(findings[0]?.message).toBe('the spacing is a guess');
    expect(findings[0]?.tier).toBe('finish');
  });

  it('passes over a line that is not a finding', () => {
    const findings = parseSloplint('checked 3 files, nothing to say');

    expect(findings).toEqual([]);
  });
});

describe('where the bridge looks for the linter', () => {
  it('looks in the project, in Claude, in the agents and in OpenCode', () => {
    const roots = skillRoots('/project', '/home/person');

    expect(roots).toEqual([
      '/project/skills',
      '/project/.opencode/skills',
      '/home/person/.claude/skills',
      '/home/person/.agents/skills',
      '/home/person/.config/opencode/skills',
    ]);
  });

  it('finds nothing where there is nothing', () => {
    expect(findSloplint('/nowhere', '/nowhere')).toBeUndefined();
  });

  it('reads the render support of the machine it runs on', () => {
    const support = renderSupport({ root: '/nowhere', home: homedir() });

    expect(support.canRender).toBe(support.puppeteer && support.chrome);
  });
});
