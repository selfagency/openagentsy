import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import type { Finding, QualityTier } from './rule.js';

/**
 * The sloplint bridge.
 *
 * Hallmark ships a linter that catches the slop the static rules cannot
 * see. It is an external tool: it is called, never vendored, so a machine
 * that does not have it is a machine that runs the static rules alone.
 *
 * The bridge never fails a check. The linter may be absent, it may crash,
 * it may run too long, and it may say something the bridge cannot read. In
 * every one of those cases the static findings stand and the reason is
 * recorded. A linter that is broken is not a reason to fail a build.
 */

/** Where the linter sits inside a skills directory. */
export const SLOPLINT_RELATIVE_PATH = 'hallmark/scripts/sloplint.mjs';

/** How long the linter may run. */
export const SLOPLINT_TIMEOUT_MS = 60_000;

/**
 * The variables the linter's child sees.
 *
 * The linter calls an API, and a key in its environment is a key that
 * leaves the machine with it. The child gets the four variables it needs to
 * run and nothing else, so a Together key in the session's environment is
 * not in the linter's.
 */
export const SLOPLINT_ENV = ['PATH', 'HOME', 'TMPDIR', 'LANG'] as const;

/** The extensions the linter reads. */
const LINTER_EXTENSIONS = ['.html', '.htm', '.css'];

/** What the bridge asks a child to do. */
export interface ChildRequest {
  /** The program to run. */
  command: string;
  /** Its arguments, one by one. Never a shell string. */
  args: string[];
  /** The environment it sees. */
  env: Record<string, string>;
  /** The directory it runs in. */
  cwd: string;
  /** How long it may run, in milliseconds. */
  timeoutMs: number;
  /** Always false: the bridge never uses a shell. */
  shell: false;
}

/** What the child did. */
export interface ChildOutcome {
  /** The exit code, when it exited on its own. */
  code: number | null;
  /** What it wrote to stdout. */
  stdout: string;
  /** What it wrote to stderr. */
  stderr: string;
  /** Whether the timeout took it. */
  timedOut: boolean;
  /** Why it did not run, when it did not run. */
  error?: string;
}

/** How a child is run. */
export type ChildRunner = (request: ChildRequest) => Promise<ChildOutcome>;

/**
 * The runner that spawns a child.
 *
 * The child is spawned without a shell, so a file name is a file name and
 * not a command. The timeout is the bridge's own, so the reason a run ended
 * is known: a linter that hangs is killed and the run is called a timeout
 * rather than a crash.
 */
export const spawnRunner: ChildRunner = async (request) => await runChild(request);

/** The child, and what it did. */
function runChild(request: ChildRequest): Promise<ChildOutcome> {
  return new Promise((resolve) => {
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, request.timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error: Error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, timedOut, error: error.message });
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** Which path ran. */
export type SloplintPath = 'static' | 'static+sloplint' | 'static+sloplint-render';

/**
 * Why the linter did not deliver.
 *
 * `absent` is a machine without Hallmark, `no-files` is a change with no
 * page and no stylesheet in it, `crashed` is a linter that failed, `timeout`
 * is a linter that ran too long and `unparsable` is a linter that said
 * something the bridge cannot read.
 */
export type SloplintDegradation = 'absent' | 'no-files' | 'crashed' | 'timeout' | 'unparsable';

/** Whether the render mode can run. */
export interface RenderSupport {
  /** Whether puppeteer-core is installed. */
  puppeteer: boolean;
  /** Whether a Chrome is installed. */
  chrome: boolean;
  /** Whether the render mode can run. */
  canRender: boolean;
}

/** What the bridge found. */
export interface SloplintResult {
  /** Which path ran. */
  path: SloplintPath;
  /** The findings the linter reported. */
  findings: Finding[];
  /** Why the linter did not deliver, when it did not. */
  degraded?: SloplintDegradation;
  /** The script that ran. */
  script?: string;
  /** Whether the render mode can run on this machine. */
  renderSupport: RenderSupport;
}

/** What the bridge needs to know. */
export interface SloplintOptions {
  /** The root of the project. */
  root: string;
  /** The files the change touched. */
  files: readonly string[];
  /** The home directory, where the skills live. */
  home?: string;
  /** How long the linter may run. */
  timeoutMs?: number;
  /** The environment of the parent, the one the child is picked from. */
  env?: NodeJS.ProcessEnv;
  /** How the child is run. */
  run?: ChildRunner;
  /** Whether the render mode can run. */
  render?: RenderSupport;
  /** The program that runs the script. */
  execPath?: string;
}

/**
 * The run of the linter.
 *
 * The result says which path ran: `static` when the linter did not deliver,
 * `static+sloplint` when it did, and `static+sloplint-render` when it did
 * with a browser to draw the page. The static findings stand in every case.
 */
export async function runSloplint(options: SloplintOptions): Promise<SloplintResult> {
  const root = options.root;
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const support = options.render ?? renderSupport({ root, home, env });
  const files = linterFiles(options.files, root);
  if (files.length === 0) return staticOnly('no-files', support);
  const script = findSloplint(root, home);
  if (script === undefined) return staticOnly('absent', support);
  const request: ChildRequest = {
    command: options.execPath ?? process.execPath,
    args: [script, ...(support.canRender ? ['--render'] : []), ...files],
    env: pickEnv(env),
    cwd: root,
    timeoutMs: options.timeoutMs ?? SLOPLINT_TIMEOUT_MS,
    shell: false,
  };
  const outcome = await (options.run ?? spawnRunner)(request);
  const output = `${outcome.stdout}\n${outcome.stderr}`;
  const findings = parseSloplint(output);
  const degraded = degradationOf(outcome, output, findings.length);
  if (degraded !== undefined) {
    return { path: 'static', findings: [], degraded, script, renderSupport: support };
  }
  return {
    path: support.canRender ? 'static+sloplint-render' : 'static+sloplint',
    findings,
    script,
    renderSupport: support,
  };
}

/** The result of a run in which the linter did not deliver. */
function staticOnly(degraded: SloplintDegradation, support: RenderSupport): SloplintResult {
  return { path: 'static', findings: [], degraded, renderSupport: support };
}

/**
 * Why a run of the linter did not deliver.
 *
 * A linter that exits with a failure and said nothing the bridge can read
 * crashed. A linter that said something the bridge cannot read and exited
 * well said something the bridge cannot read. A linter that found something
 * is a linter that worked, whatever its exit code.
 */
function degradationOf(
  outcome: ChildOutcome,
  output: string,
  found: number,
): SloplintDegradation | undefined {
  if (outcome.error !== undefined) return 'crashed';
  if (outcome.timedOut) return 'timeout';
  if (found > 0) return undefined;
  if (outcome.code !== 0) return 'crashed';
  if (output.trim() !== '') return 'unparsable';
  return undefined;
}

/**
 * The roots the linter is looked for in.
 *
 * The plan names four places: the project, Claude, the agents and OpenCode.
 * The project holds two of them, because a project may carry the skills
 * beside its code or in the OpenCode directory of its own.
 */
export function skillRoots(root: string, home: string): string[] {
  return [
    join(root, 'skills'),
    join(root, '.opencode', 'skills'),
    join(home, '.claude', 'skills'),
    join(home, '.agents', 'skills'),
    join(home, '.config', 'opencode', 'skills'),
  ];
}

/** The script, when one of the roots holds it. */
export function findSloplint(root: string, home: string): string | undefined {
  for (const skills of skillRoots(root, home)) {
    const candidate = join(skills, SLOPLINT_RELATIVE_PATH);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** The files the linter reads, as the linter is told about them. */
function linterFiles(files: readonly string[], root: string): string[] {
  return files
    .filter((file) => LINTER_EXTENSIONS.includes(extensionOf(file)))
    .map((file) => relativeFile(root, file));
}

/** The extension of a file, with its dot, in small letters. */
function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  return name.slice(dot).toLowerCase();
}

/** The file, as the linter is told about it: relative to the root. */
function relativeFile(root: string, file: string): string {
  if (!isAbsolute(file)) return file;
  const rel = relative(root, file);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return file;
  return rel;
}

/**
 * The environment of the linter's child.
 *
 * The child gets the four variables it needs to run and nothing else, so a
 * Together key in the session's environment is not in the linter's.
 */
export function pickEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const key of SLOPLINT_ENV) {
    const value = env[key];
    if (value !== undefined) picked[key] = value;
  }
  return picked;
}

/**
 * The render support of the machine.
 *
 * The render mode needs a browser to draw the page, so it needs
 * puppeteer-core and a Chrome. A machine with one of them and not the other
 * has no render mode, and the bridge says so instead of trying and failing.
 */
export function renderSupport(options: {
  root: string;
  home: string;
  env?: NodeJS.ProcessEnv;
}): RenderSupport {
  const env = options.env ?? process.env;
  const puppeteer = hasPuppeteer(options.root, options.home);
  const chrome = hasChrome(env);
  return { puppeteer, chrome, canRender: puppeteer && chrome };
}

/** The places puppeteer-core is looked for in. */
function puppeteerRoots(root: string, home: string): string[] {
  return [
    join(root, 'node_modules', 'puppeteer-core'),
    join(home, 'node_modules', 'puppeteer-core'),
    join(home, '.agents', 'node_modules', 'puppeteer-core'),
    join(home, '.config', 'opencode', 'node_modules', 'puppeteer-core'),
  ];
}

/** Whether puppeteer-core is installed. */
function hasPuppeteer(root: string, home: string): boolean {
  return puppeteerRoots(root, home).some((dir) => existsSync(dir));
}

/** The places a Chrome is looked for in. */
const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

/** Whether a Chrome is installed. */
function hasChrome(env: NodeJS.ProcessEnv): boolean {
  const named = env.CHROME_PATH;
  if (named !== undefined && named !== '' && existsSync(named)) return true;
  return CHROME_PATHS.some((path) => existsSync(path));
}

/**
 * The tier each tag of the linter means.
 *
 * A FAIL is a floor finding: the linter found something the rules hold
 * wrong, and it blocks the task. A REFLEX is a tell: a person may waive it
 * with a reason. A WARN is taste: it warns and nothing else. The mapping is
 * the one the tiers of this package use, so a finding of the linter is a
 * finding of the rules like any other.
 */
const TIER_BY_TAG: Record<string, QualityTier> = {
  FAIL: 'floor',
  REFLEX: 'reflex',
  WARN: 'finish',
};

/** The tag of a line of the linter's output. */
const TAG = /^\s*(FAIL|REFLEX|WARN)\b:?\s*(.*)$/;

/** The place of a finding: a file, a line and a message. */
const PLACE = /^([^\s:]+):(\d+)\s*(?:[-—–]\s*)?(.*)$/;

/** The place of a finding without a line. */
const FILE = /^([^\s]+)\s*[-—–]\s*(.*)$/;

/**
 * The findings of the linter's output.
 *
 * The linter writes one line per finding, and the line starts with the tier
 * the finding has. A line the bridge cannot read is not a finding, so it is
 * passed over, and a run whose lines are none of them is a run the bridge
 * cannot read.
 */
export function parseSloplint(output: string): Finding[] {
  const findings: Finding[] = [];
  for (const line of output.split('\n')) {
    const finding = parseLine(line);
    if (finding !== undefined) findings.push(finding);
  }
  return findings;
}

/** The finding of a line of the linter's output. */
function parseLine(line: string): Finding | undefined {
  const tagged = TAG.exec(line);
  if (tagged === null) return undefined;
  const tag = tagged[1];
  if (tag === undefined) return undefined;
  const tier = TIER_BY_TAG[tag];
  if (tier === undefined) return undefined;
  const place = placeOf(tagged[2] ?? '');
  return {
    ruleId: `hallmark/sloplint-${tag.toLowerCase()}`,
    source: 'hallmark',
    tier,
    file: place.file,
    line: place.line,
    message: place.message,
    fix: 'Fix what the linter reported.',
  };
}

/** The place a line of the linter's output names. */
function placeOf(rest: string): { file: string; line: number; message: string } {
  const withLine = PLACE.exec(rest);
  if (withLine !== null) {
    return {
      file: withLine[1] ?? '',
      line: Number(withLine[2] ?? 0),
      message: withLine[3] ?? '',
    };
  }
  const withFile = FILE.exec(rest);
  if (withFile !== null) {
    return { file: withFile[1] ?? '', line: 0, message: withFile[2] ?? '' };
  }
  return { file: '', line: 0, message: rest };
}
