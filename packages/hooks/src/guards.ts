import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { cwd } from 'node:process';
import type { PreToolCallEvent } from './event.js';
import { pathSegments } from './paths.js';

/**
 * The scans the guardrails are made of.
 *
 * A command is read here, a path is judged here, and the content of a write
 * is read here. The rules and the policy modules both need these readings,
 * so they live in one place: a reading that is written twice is a reading
 * that can drift, and a guardrail that drifts from its own policy is a
 * guardrail nobody can reason about.
 */

/**
 * The command, read in pieces.
 *
 * A quoted span is one piece, so a command that is passed as a quoted
 * argument stays one thing. The pieces are cut at the given characters,
 * and the quotes are kept, so the caller can tell a value from an
 * argument.
 */
function scanCommand(command: string, cuts: (char: string) => boolean): string[] {
  const pieces: string[] = [];
  let current = '';
  let quote: string | undefined;
  for (const char of command) {
    if (quote !== undefined) {
      current += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (cuts(char)) {
      if (current !== '') pieces.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current !== '') pieces.push(current);
  return pieces;
}

/**
 * The command, split into tokens.
 *
 * A quoted span is one token, so a command that is passed as a quoted
 * argument stays one thing: `bash -c "git commit -n"` is three tokens and
 * the third one holds the command. The quotes are kept, so the caller can
 * tell a value from an argument.
 */
export function tokenise(command: string): string[] {
  return scanCommand(command, (char) => /\s/.test(char));
}

/**
 * A token without its quotes.
 */
function unquote(token: string): string {
  if (token.length < 2) return token;
  const first = token[0];
  const last = token[token.length - 1];
  if ((first === '"' || first === "'") && first === last) return token.slice(1, -1);
  return token;
}

/**
 * The flags whose value is a message and not an argument.
 */
const MESSAGE_FLAGS = new Set(['-m', '--message', '-F', '--file']);

/** The message flags that carry their value with an equals sign. */
const MESSAGE_FLAG_PREFIXES = ['-m=', '--message=', '-F=', '--file='];

/** The git subcommands whose arguments the hook rule reads. */
const GIT_SUBCOMMANDS = new Set(['commit', 'merge', 'rebase']);

/** The characters that end a command. */
const SEPARATOR_CHARS = new Set([';', '&', '|', '(', ')', '\n']);

/**
 * Whether a token is a quoted span.
 */
function isQuoted(token: string): boolean {
  if (token.length < 2) return false;
  const first = token[0];
  const last = token[token.length - 1];
  return (first === '"' || first === "'") && first === last;
}

/**
 * The command, split into the segments a separator ends.
 *
 * A separator inside a quoted span does not end a segment: the span is one
 * argument, and a command in it belongs to the command that holds the
 * argument.
 */
export function commandSegments(command: string): string[] {
  return scanCommand(command, (char) => SEPARATOR_CHARS.has(char)).filter(
    (piece) => piece.trim() !== '',
  );
}

/**
 * Whether the tokens are a git command the hook rule reads.
 */
function isGitParse(tokens: readonly string[]): boolean {
  const gitIndex = tokens.indexOf('git');
  if (gitIndex === -1) return false;
  const next = tokens[gitIndex + 1];
  return next !== undefined && GIT_SUBCOMMANDS.has(next);
}

/**
 * The tokens of a segment, without the values of the message flags.
 *
 * The value of a message flag is a message and not an argument, and it is
 * dropped only inside a git command: `git commit -m "docs: explain rm
 * -rf /"` is a commit whose message talks about a removal, while the `-m`
 * of another command is that command's own flag.
 */
function segmentTokens(segment: string): string[] {
  const tokens = tokenise(segment);
  if (!isGitParse(tokens)) return tokens;
  const kept: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (MESSAGE_FLAGS.has(token)) {
      index += 1;
      continue;
    }
    if (MESSAGE_FLAG_PREFIXES.some((flag) => token.startsWith(flag))) continue;
    kept.push(token);
  }
  return kept;
}

/**
 * The payload of every substitution in a command.
 *
 * The shell runs a substitution before the command that holds it, so the
 * payload is a command of its own: `git commit -m "$(rm -rf /)"` removes the
 * directory even though the message is only text.
 */
export function substitutionPayloads(command: string): string[] {
  const payloads: string[] = [];
  const patterns = [/\$\(([^()]*)\)/g, /<\(([^()]*)\)/g, /`([^`]*)`/g];
  for (const pattern of patterns) {
    for (const match of command.matchAll(pattern)) {
      const payload = match[1];
      if (payload !== undefined && payload.trim() !== '') payloads.push(payload);
    }
  }
  return payloads;
}

/**
 * The scope of the shell matcher.
 *
 * It covers: the flags of a removal in any order and either spelling, the
 * git commands that skip the hooks, the other package managers, and the
 * payload of every quoted span and every substitution, which is scanned as
 * a command of its own.
 *
 * It does not cover: the shell itself. The matcher reads the commands a
 * shell runs, not the shell: a payload behind a construct this matcher does
 * not read - an alias, a function, a here-document, a variable - is not
 * seen. A name the matcher does not know is treated as a writer, not as a
 * reader.
 */
export function scannedParts(command: string): string[] {
  const parts: string[] = [];
  for (const segment of commandSegments(command)) {
    parts.push(...segmentParts(segment));
  }
  for (const payload of substitutionPayloads(command)) {
    parts.push(...scannedParts(payload));
  }
  return parts;
}

/**
 * The parts of one segment.
 *
 * The quotes are flattened, so a command in a quoted span is read, and the
 * separators the span held are separators again.
 */
function segmentParts(segment: string): string[] {
  const tokens = segmentTokens(segment);
  const parts = commandSegments(tokens.map((token) => unquote(token)).join(' '));
  for (const token of tokens) {
    if (!isQuoted(token)) continue;
    parts.push(...scannedParts(unquote(token)));
  }
  return parts;
}

/**
 * Whether a command skips the git hooks.
 *
 * The `-n` of `git commit` is the short form of `--no-verify`, and it is
 * caught in any position of the commit's own arguments:
 * `git commit -n`, `git commit -m "wip" -n`, `git commit -a -n` and
 * `git commit -nm "wip"` all skip the hooks. A command that is passed as a
 * quoted argument is read too, so `bash -c "git commit -n"` is caught.
 */
export function skipsGitHooks(command: string): boolean {
  return scannedParts(command).some((part) => partSkipsHooks(part));
}

/**
 * Whether a part of a command skips the git hooks.
 *
 * The flags are read from the arguments of the git subcommand alone: the
 * `-n` of `git merge` is `--no-stat`, the `-n` of `sudo` belongs to sudo,
 * and after `--` a git command takes pathspecs. The long flag is matched
 * by the prefixes git accepts, so `--no-verbose` is not a skip.
 */
function partSkipsHooks(part: string): boolean {
  if (/\bHUSKY=0\b/.test(part)) return true;
  if (/\bcore\.hooksPath\b/.test(part)) return true;
  const tokens = part.split(/\s+/).filter((token) => token.length > 0);
  const gitIndex = tokens.indexOf('git');
  if (gitIndex === -1) return false;
  const subIndex = tokens.findIndex(
    (token, index) => index > gitIndex && GIT_SUBCOMMANDS.has(token),
  );
  if (subIndex === -1) return false;
  const args: string[] = [];
  for (const token of tokens.slice(subIndex + 1)) {
    if (token === '--') break;
    args.push(token);
  }
  if (args.some((token) => /^--no-(veri|verif|verify)$/.test(token))) return true;
  // The -n is the short form of --no-verify for commit alone.
  if (tokens[subIndex] !== 'commit') return false;
  return args.some((token) => /^-([A-Za-z]+)$/.exec(token)?.[1]?.includes('n') === true);
}

/**
 * The package manager is Bun.
 *
 * A second package manager writes a second lockfile, and the two lockfiles
 * disagree about what the project depends on. The name is caught wherever
 * it is written, so a path to another package manager is caught too.
 */
const OTHER_PM = /(^|[\s;&|(/\\])(pnpm|yarn|npx|npm\s+(i|install|ci|add|exec))\b/i;

/**
 * The files a person changes.
 *
 * The trust boundary is wider than the roles file: the model lock and the
 * agent files are generated, the workflows run CI, the templates
 * regenerate the agents, and the lessons, the waivers and the approvals
 * are decisions.
 */
const PROTECTED_FILES = new Set([
  'roles.yaml',
  'openagentsy.models.lock.json',
  'openagentsy.jsonc',
  'biome.jsonc',
  'turbo.json',
  'bunfig.toml',
  'bun.lock',
  'opencode.json',
  'opencode.jsonc',
]);

/** The directories a person changes. */
const PROTECTED_DIRS = ['.opencode', '.husky', '.github/workflows', 'templates'];

/**
 * The state a person changes, under the state root.
 */
const PROTECTED_STATE = [
  '.openagentsy/lessons',
  '.openagentsy/quality/waivers.json',
  '.openagentsy/conformance.json',
  '.openagentsy/memory.jsonl',
  '.openagentsy/approvals.json',
];

/**
 * The lock family of the approval store.
 *
 * Every name in it is protected: the lock, the reclaim file, the stale
 * file and the private copy a release makes. They are the store's, and an
 * agent that removes one of them breaks the serialisation.
 */
function isApprovalLock(segments: readonly string[]): boolean {
  if (!segments.includes('.openagentsy')) return false;
  const last = segments[segments.length - 1] ?? '';
  return last.startsWith('approvals.json.lock');
}

/**
 * Whether the segments of a path hold a run of segments.
 */
function holdsSegments(segments: string[], wanted: string[]): boolean {
  if (wanted.length === 0 || wanted.length > segments.length) return false;
  for (let start = 0; start + wanted.length <= segments.length; start += 1) {
    if (wanted.every((segment, index) => segments[start + index] === segment)) return true;
  }
  return false;
}

/**
 * Whether a path is one a person changes.
 *
 * The path is compared on its segments, so a directory is a directory
 * whether or not the path names it with a trailing slash, and a file is a
 * file wherever it sits. A delete or a move that names the directory
 * itself is caught as well.
 */
export function isProtected(path: string): boolean {
  const segments = pathSegments(path);
  if (segments.length === 0) return false;
  const last = segments[segments.length - 1] ?? '';
  if (PROTECTED_FILES.has(last)) return true;
  for (const dir of PROTECTED_DIRS) {
    if (holdsSegments(segments, dir.split('/'))) return true;
  }
  for (const entry of PROTECTED_STATE) {
    if (holdsSegments(segments, entry.split('/'))) return true;
  }
  return isApprovalLock(segments);
}

/**
 * A write a shell command would make.
 *
 * The path is the one the command names, and it is missing when the command
 * writes files it names no path for: `git apply` writes the files its patch
 * names, and `git stash` writes the files it stashes.
 */
export interface ShellWrite {
  /** The path the command writes, when it names one. */
  path?: string;
  /** The part of the command that makes the write. */
  source: string;
  /** The name of the command, when it writes files it names no path for. */
  command?: string;
  /** Whether the write is one the command is allowed to make. */
  exempt: boolean;
}

/**
 * What a shell command would write that a person changes.
 *
 * A named path is a file the guard can look at, and a blind command is one
 * that can write any file and names no path for.
 */
export type ShellViolation =
  | { kind: 'protected'; path: string }
  | { kind: 'blind'; command: string };

/**
 * The part of a command, as its writes are made from it.
 */
interface WriteContext {
  /** The part of the command that makes the write. */
  source: string;
  /** The tokens of the part. */
  tokens: readonly string[];
  /** The root a relative path is read against. */
  root?: string | undefined;
}

/**
 * The flags that take a value, per command.
 *
 * The value of a flag is not an operand, so a mode, a size or a date is not
 * mistaken for a path: `install -m 644 source dest` writes `dest`, and
 * `truncate -s 0 roles.yaml` writes the file and not the zero.
 */
const VALUE_FLAGS: Record<string, readonly string[]> = {
  cp: ['-t', '--target-directory'],
  mv: ['-t', '--target-directory'],
  rm: [],
  ln: ['-t', '--target-directory'],
  tee: [],
  truncate: ['-s', '--size', '-c', '--io-blocks', '-r', '--reference'],
  install: ['-m', '--mode', '-o', '--owner', '-g', '--group', '-t', '--target-directory', '-D'],
  dd: [],
  touch: ['-d', '--date', '-r', '--reference', '-t'],
  mkdir: ['-m', '--mode'],
  chmod: ['--reference', '--from', '--to'],
  chown: ['--reference', '--from', '--to'],
  rsync: [
    '-e',
    '--rsh',
    '--exclude',
    '--include',
    '--filter',
    '--chown',
    '--chmod',
    '--out-format',
    '--backup-dir',
    '--temp-dir',
    '--max-size',
    '--min-size',
  ],
  sed: ['-e', '--expression', '-f', '--file'],
  git: [
    '-C',
    '-c',
    '-b',
    '-B',
    '-m',
    '-s',
    '-t',
    '--source',
    '--work-tree',
    '--git-dir',
    '--exec-path',
    '--namespace',
    '--orphan',
    '--track',
  ],
};

/**
 * The commands that put another command in front of one.
 *
 * `sudo cp a roles.yaml` is a copy, and the wrapper in front of it is not
 * the command that writes.
 */
const WRAPPERS = new Set([
  'sudo',
  'doas',
  'command',
  'env',
  'nohup',
  'time',
  'nice',
  'ionice',
  'stdbuf',
  'xargs',
]);

/** The flags of a wrapper that take a value. */
const WRAPPER_VALUE_FLAGS: Record<string, readonly string[]> = {
  sudo: ['-u', '-g', '-p', '-C', '-h', '-r', '-t', '-U'],
  doas: ['-u'],
  nice: ['-n'],
  ionice: ['-c', '-n', '-p'],
  time: [],
  env: [],
  command: [],
  nohup: [],
  stdbuf: [],
  xargs: [],
};

/**
 * The bun subcommands that write the lockfile.
 */
const LOCK_WRITER_SUBCOMMANDS = new Set(['install', 'add', 'remove']);

/**
 * The trees the generator writes.
 *
 * The generator renders the agent files, the commands and the skills from
 * the roles and the templates, and it writes them under `.opencode/`.
 */
const GENERATOR_TREES = ['.opencode/agents', '.opencode/commands', '.opencode/skills'];

/**
 * The git subcommands that write the working tree.
 */
const GIT_WRITE_SUBCOMMANDS = new Set(['checkout', 'restore', 'apply', 'stash']);

/**
 * The name of a command, without the path it sits at.
 */
function commandName(token: string): string {
  return token.split('/').pop() ?? token;
}

/**
 * The index of the token that names the command.
 *
 * The wrappers are stepped over, and the assignments of `env` are skipped,
 * so the command behind them is the one that writes.
 */
function commandIndex(tokens: readonly string[]): number {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index] ?? '';
    if (!WRAPPERS.has(token)) break;
    index = wrapperEnd(tokens, index + 1, token);
  }
  return index;
}

/**
 * The index of the token behind a wrapper.
 *
 * The flags of the wrapper are stepped over, and so are the values they
 * take, so the command behind the wrapper is the one that writes.
 */
function wrapperEnd(tokens: readonly string[], start: number, wrapper: string): number {
  const valueFlags = WRAPPER_VALUE_FLAGS[wrapper] ?? [];
  let index = start;
  while (index < tokens.length) {
    const next = tokens[index] ?? '';
    if (next.length > 1 && next.startsWith('-')) {
      if (valueFlags.includes(next)) index += 1;
      index += 1;
      continue;
    }
    if (wrapper === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(next)) {
      index += 1;
      continue;
    }
    break;
  }
  return index;
}

/**
 * The operands of a command: the tokens that are paths and not flags.
 */
function operands(tokens: readonly string[], command: string): string[] {
  const valueFlags = VALUE_FLAGS[command] ?? [];
  const result: string[] = [];
  let skip = false;
  for (const token of tokens) {
    if (skip) {
      skip = false;
      continue;
    }
    if (token === '--') continue;
    if (token.startsWith('--')) continue;
    if (token.length > 1 && token.startsWith('-')) {
      if (valueFlags.includes(token)) skip = true;
      continue;
    }
    result.push(token);
  }
  return result;
}

/**
 * The targets of the redirects of a command.
 *
 * A redirect names the file it writes, and the number in front of it is the
 * stream and not part of the path. A redirect that duplicates a stream
 * (`2>&1`) writes no file.
 */
function redirectTargets(tokens: readonly string[]): string[] {
  const targets: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (/^(?:\d*)(>>?)$/.test(token)) {
      const next = tokens[index + 1];
      if (next !== undefined) {
        targets.push(next);
        index += 1;
      }
      continue;
    }
    const attached = /^(?:\d*)(>>?)([^&].*)$/.exec(token);
    if (attached !== null) targets.push(attached[2] ?? '');
  }
  return targets;
}

/**
 * The file a `dd` writes.
 */
function ddTarget(tokens: readonly string[]): string | undefined {
  for (const token of tokens) {
    const match = /^of=(.+)$/.exec(token);
    if (match !== null) return match[1] ?? undefined;
  }
  return undefined;
}

/**
 * The files a `sed` writes in place.
 *
 * The script of a `sed` is an operand and not a file, so it is dropped
 * unless the script was given with `-e` or `-f`.
 */
function sedTargets(tokens: readonly string[]): string[] {
  const inPlace = tokens.some(
    (token) =>
      token === '-i' ||
      token === '--in-place' ||
      token.startsWith('-i.') ||
      token.startsWith('--in-place='),
  );
  if (!inPlace) return [];
  const hasScript = tokens.some(
    (token) =>
      token === '-e' ||
      token === '--expression' ||
      token === '-f' ||
      token === '--file' ||
      token.startsWith('--expression=') ||
      token.startsWith('--file=') ||
      /^-[ef]./.test(token),
  );
  const paths = operands(tokens, 'sed');
  return hasScript ? paths : paths.slice(1);
}

/**
 * The files a git command writes.
 *
 * The paths of a `checkout`, a `restore` and a `stash` are the pathspecs,
 * and a pathspec that is the tree itself (`.`) names every file of it. A
 * command that writes files it names no path for is a blind write: `git
 * apply` writes the files its patch names, and `git stash` writes the
 * files it stashes.
 */
function gitWrites(rest: readonly string[], ctx: WriteContext): ShellWrite[] {
  const index = rest.findIndex((token) => GIT_WRITE_SUBCOMMANDS.has(token));
  if (index === -1) return [];
  const subcommand = rest[index] ?? '';
  const args = rest.slice(index + 1);
  if (subcommand === 'apply') return applyWrites(args, ctx);
  const paths = gitPaths(subcommand, args);
  if (paths === undefined) return [blindWrite(`git ${subcommand}`, ctx)];
  if (paths.length === 0) {
    // A `restore` without a pathspec restores the whole tree, and a
    // `checkout` without one switches a branch and writes nothing.
    if (subcommand === 'restore') return [blindWrite('git restore', ctx)];
    return [];
  }
  const writes: ShellWrite[] = [];
  for (const path of paths) {
    if (isWholeTree(path)) {
      writes.push(blindWrite(`git ${subcommand}`, ctx));
      continue;
    }
    writes.push(shellWrite(path, ctx));
  }
  return writes;
}

/**
 * The paths a git command writes.
 *
 * The pathspecs follow the `--`, and a `stash` without one covers the
 * whole tree.
 */
function gitPaths(subcommand: string, args: readonly string[]): string[] | undefined {
  const separator = args.indexOf('--');
  if (separator !== -1) return args.slice(separator + 1);
  if (subcommand === 'stash') return undefined;
  return operands(args, 'git');
}

/**
 * The files a `git apply` writes.
 *
 * The patch names the files it writes in its headers, and the paths are
 * read out of the patch file. A patch that cannot be read, or that names no
 * file, writes files the matcher cannot see.
 */
function applyWrites(args: readonly string[], ctx: WriteContext): ShellWrite[] {
  const patches = operands(args, 'git').filter((patch) => patch !== '-');
  if (patches.length === 0) return [blindWrite('git apply', ctx)];
  const writes: ShellWrite[] = [];
  for (const patch of patches) {
    const targets = patchTargets(patch, ctx.root);
    if (targets === undefined) {
      writes.push(blindWrite('git apply', ctx));
      continue;
    }
    for (const target of targets) writes.push(shellWrite(target, ctx));
  }
  return writes;
}

/**
 * The files a patch writes.
 */
function patchTargets(patch: string, root?: string): string[] | undefined {
  const text = readPatch(patch, root);
  if (text === undefined) return undefined;
  const paths = patchPaths(text);
  return paths.length === 0 ? undefined : paths;
}

/**
 * The text of a patch file.
 *
 * The patch is a file of the workspace, and a patch that cannot be read is
 * a patch whose files the matcher cannot see.
 */
function readPatch(patch: string, root?: string): string | undefined {
  const base = root ?? cwd();
  const path = isAbsolute(patch) ? patch : resolve(base, patch);
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * The paths a unified diff writes.
 *
 * The diff names the file of every hunk in its `+++` header.
 */
function patchPaths(text: string): string[] {
  const paths: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('+++ ')) continue;
    const value = (line.slice(4).split('\t')[0] ?? '').trim();
    if (value === '' || value === '/dev/null') continue;
    paths.push(value.startsWith('b/') ? value.slice(2) : value);
  }
  return paths;
}

/**
 * Whether the tokens run the OpenAgentsy CLI.
 */
function isCliToken(token: string): boolean {
  if (token === 'openagentsy') return true;
  if (/^@[^/]+\/openagentsy(@.+)?$/.test(token)) return true;
  return token.endsWith('packages/cli/dist/index.js');
}

/**
 * Whether the command is the generator.
 *
 * The generator is the CLI with its `build` subcommand, however it is
 * invoked: `openagentsy build`, `bun run openagentsy build` and
 * `bun packages/cli/dist/index.js build` are the same command.
 */
function isGeneratorInvocation(tokens: readonly string[]): boolean {
  if (!tokens.includes('build')) return false;
  return tokens.some((token) => isCliToken(token));
}

/**
 * Whether the command is bun writing the lockfile.
 */
function isLockInvocation(tokens: readonly string[]): boolean {
  const index = tokens.findIndex((token) => commandName(token) === 'bun');
  if (index === -1) return false;
  const subcommand = tokens[index + 1];
  return subcommand !== undefined && LOCK_WRITER_SUBCOMMANDS.has(subcommand);
}

/**
 * Whether the path is one the generator writes.
 */
function isGeneratorTree(path: string): boolean {
  return GENERATOR_TREES.some((tree) => path === tree || path.startsWith(`${tree}/`));
}

/**
 * Whether the write is one the command is allowed to make.
 *
 * Two commands are allowed to write the files they own: bun writes the
 * lockfile, and the generator writes the agent files it renders. The
 * exemption is bound to the command and not to the file, so a copy of the
 * lockfile is not bun writing the lockfile.
 */
function isExemptWrite(tokens: readonly string[], path: string): boolean {
  if (isLockInvocation(tokens) && commandName(path) === 'bun.lock') return true;
  if (isGeneratorInvocation(tokens) && isGeneratorTree(path)) return true;
  return false;
}

/**
 * A write, made by a part of a command.
 */
function shellWrite(path: string, ctx: WriteContext): ShellWrite {
  return { path, source: ctx.source, exempt: isExemptWrite(ctx.tokens, path) };
}

/**
 * A write of files the command names no path for.
 */
function blindWrite(command: string, ctx: WriteContext): ShellWrite {
  return { source: ctx.source, command, exempt: false };
}

/**
 * Whether the path names the tree itself.
 *
 * The tree is every file of it, and a command that names it names no file.
 */
function isWholeTree(path: string): boolean {
  return path === '.' || path === './';
}

/**
 * The writes a part of a command would make.
 *
 * The part is one command, and the commands that write are the copy, the
 * move, the removal, the link, the tee, the truncation, the install, the
 * `dd`, the `sed`, the `mkdir`, the `chmod`, the `chown`, the `rsync` and
 * the git commands that write the working tree. A command the matcher does
 * not know writes nothing it can name.
 */
function partWrites(part: readonly string[], root?: string): ShellWrite[] {
  const tokens = part.map(unquote);
  const ctx: WriteContext = { source: part.join(' '), tokens, root };
  const writes: ShellWrite[] = [];
  for (const target of redirectTargets(tokens)) {
    writes.push(shellWrite(target, ctx));
  }
  const index = commandIndex(tokens);
  const name = commandName(tokens[index] ?? '');
  const rest = tokens.slice(index + 1);
  if (isGeneratorInvocation(tokens)) {
    for (const tree of GENERATOR_TREES) writes.push(shellWrite(tree, ctx));
    return writes;
  }
  if (name === 'bun') {
    const subcommand = rest[0];
    if (subcommand !== undefined && LOCK_WRITER_SUBCOMMANDS.has(subcommand)) {
      writes.push(shellWrite('bun.lock', ctx));
    }
    return writes;
  }
  writes.push(...commandWrites(name, rest, ctx));
  return writes;
}

/**
 * The commands that write the file they name last.
 */
const DESTINATION_WRITERS = new Set(['cp', 'ln']);

/**
 * The commands that write every file they name.
 */
const OPERAND_WRITERS = new Set(['mv', 'rm', 'tee', 'truncate', 'touch', 'mkdir', 'rsync']);

/**
 * The commands whose first operand is not a file.
 */
const MODE_WRITERS = new Set(['chmod', 'chown']);

/**
 * The writes of the command a part names.
 */
function commandWrites(name: string, rest: readonly string[], ctx: WriteContext): ShellWrite[] {
  if (DESTINATION_WRITERS.has(name)) return destinationWrites(rest, name, ctx);
  if (OPERAND_WRITERS.has(name)) return operandWrites(rest, name, ctx);
  if (MODE_WRITERS.has(name)) return modeWrites(rest, name, ctx);
  if (name === 'install') return installWrites(rest, ctx);
  if (name === 'dd') return ddWrites(rest, ctx);
  if (name === 'sed') return sedWrites(rest, ctx);
  if (name === 'git') return gitWrites(rest, ctx);
  return [];
}

/**
 * The writes of a copy and of a link: the file they create.
 */
function destinationWrites(rest: readonly string[], name: string, ctx: WriteContext): ShellWrite[] {
  const paths = operands(rest, name);
  const last = paths[paths.length - 1];
  if (last === undefined) return [];
  return [shellWrite(last, ctx)];
}

/**
 * The writes of a command that writes every file it names.
 *
 * A removal is one of them: it destroys the file, and a file a person
 * changes is not destroyed by an agent. A path that names the tree itself
 * writes every file of it, and the command names no path for any of them.
 */
function operandWrites(rest: readonly string[], name: string, ctx: WriteContext): ShellWrite[] {
  const writes: ShellWrite[] = [];
  for (const path of operands(rest, name)) {
    if (isWholeTree(path)) {
      writes.push(blindWrite(name, ctx));
      continue;
    }
    writes.push(shellWrite(path, ctx));
  }
  return writes;
}

/**
 * The writes of a command whose first operand is not a file.
 *
 * The mode of a `chmod` and the owner of a `chown` are not files, and the
 * files follow them.
 */
function modeWrites(rest: readonly string[], name: string, ctx: WriteContext): ShellWrite[] {
  const paths = operands(rest, name);
  const files = paths.length > 1 ? paths.slice(1) : paths;
  return files.map((path) => shellWrite(path, ctx));
}

/**
 * The writes of an install.
 *
 * An install of a file writes the file it installs, and an install of
 * directories writes every directory it names.
 */
function installWrites(rest: readonly string[], ctx: WriteContext): ShellWrite[] {
  const paths = operands(rest, 'install');
  const directories = rest.some((token) => token === '-d' || token === '--directory');
  const targets = directories ? paths : paths.slice(-1);
  return targets.map((path) => shellWrite(path, ctx));
}

/**
 * The writes of a `dd`.
 */
function ddWrites(rest: readonly string[], ctx: WriteContext): ShellWrite[] {
  const target = ddTarget(rest);
  if (target === undefined) return [];
  return [shellWrite(target, ctx)];
}

/**
 * The writes of a `sed` in place.
 */
function sedWrites(rest: readonly string[], ctx: WriteContext): ShellWrite[] {
  return sedTargets(rest).map((path) => shellWrite(path, ctx));
}

/**
 * The parts of a command, as the token lists they are read as.
 *
 * A part is one command, and a quoted span is a command of its own: the
 * span is read as a command, and the tokens of the part keep their quotes,
 * so a path with a space in it stays one path.
 */
function writeParts(command: string): string[][] {
  const parts: string[][] = [];
  for (const segment of commandSegments(command)) {
    const tokens = segmentTokens(segment);
    parts.push(tokens);
    for (const token of tokens) {
      if (!isQuoted(token)) continue;
      parts.push(...writeParts(unquote(token)));
    }
  }
  for (const payload of substitutionPayloads(command)) {
    parts.push(...writeParts(payload));
  }
  return parts;
}

/**
 * The writes a shell command would make.
 *
 * The command is read through the matcher, so a command inside a quoted
 * span or inside a substitution is read as a command of its own: `bash -c
 * "cp source roles.yaml"` writes the roles file, and so does `echo $(cp
 * source roles.yaml)`.
 */
export function shellWriteTargets(command: string, root?: string): ShellWrite[] {
  const writes: ShellWrite[] = [];
  for (const part of writeParts(command)) {
    writes.push(...partWrites(part, root));
  }
  return writes;
}

/**
 * What a shell command would write that a person changes.
 *
 * A relative path is read against the root of the workspace, and an
 * absolute path is read as it is. A write that the command is allowed to
 * make - bun writing the lockfile, the generator writing the agent files -
 * is not a write to a file a person changes. A command that can write any
 * file and names no path for is a blind write, and a blind write cannot be
 * shown to be safe.
 */
export function shellViolation(command: string, root?: string): ShellViolation | undefined {
  for (const write of shellWriteTargets(command, root)) {
    if (write.exempt) continue;
    if (write.path === undefined) {
      return { kind: 'blind', command: write.command ?? write.source };
    }
    const path = root === undefined ? write.path : resolve(root, write.path);
    if (isProtected(path)) return { kind: 'protected', path: write.path };
  }
  return undefined;
}

/**
 * Whether a flag makes a removal recursive.
 */
function isRecursiveFlag(flag: string): boolean {
  if (flag.startsWith('--')) return flag === '--recursive';
  const letters = flag.slice(1);
  return letters.includes('r') || letters.includes('R');
}

/**
 * Whether a flag makes a removal forced.
 */
function isForceFlag(flag: string): boolean {
  if (flag.startsWith('--')) return flag === '--force';
  return flag.slice(1).includes('f');
}

/**
 * Whether a token names the removal.
 *
 * The name may follow the punctuation of the shell: `(rm`, `\rm` and
 * `;rm` are the removal, and a subshell runs it.
 */
function isRmToken(token: string): boolean {
  return /(^|[/\\();|&])rm$/.test(token);
}

/**
 * The flags of a removal.
 *
 * The flags are read to the end of the segment, because GNU `rm` permutes
 * them: `rm build -rf` is `rm -rf build`. An operand is not a flag and
 * does not end the scan, and `--` ends it.
 */
function rmFlags(tokens: readonly string[], from: number): string[] {
  const flags: string[] = [];
  for (let index = from; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || token === '--') break;
    if (!token.startsWith('-')) continue;
    flags.push(token);
  }
  return flags;
}

/**
 * Whether the flags are a recursive and a forced removal.
 */
function isDangerousFlags(flags: string[]): boolean {
  return flags.some(isRecursiveFlag) && flags.some(isForceFlag);
}

/**
 * Whether the text holds a destructive `rm`.
 *
 * The flags of the removal are read in any order and in either spelling,
 * and the dangerous pair is a recursive removal and a force: `rm -rf`,
 * `rm -fr`, `rm -r -f` and `rm --recursive --force` are the same command.
 * A removal that is not both is not the dangerous one.
 */
function hasDestructiveRm(command: string): boolean {
  const tokens = command.split(/\s+/).filter((token) => token.length > 0);
  return tokens.some(
    (token, index) => isRmToken(token) && isDangerousFlags(rmFlags(tokens, index + 1)),
  );
}

/**
 * Whether a command destroys something.
 *
 * The command is read in parts, so a destructive command inside a
 * substitution or inside a quoted argument is still one: `echo $(rm -rf
 * /)` and `bash -c "rm -rf /"` are both caught. The flags of a removal
 * are read per part, so `rm -r build; rm -f /tmp/x` is two removals and
 * neither is the dangerous one.
 */
export function isDestructiveCommand(command: string): boolean {
  return scannedParts(command).some((part) => partIsDestructive(part));
}

/**
 * Whether a part of a command destroys something.
 */
function partIsDestructive(part: string): boolean {
  if (/\bgit\s+push\s+--force\b/i.test(part)) return true;
  if (/\bgit\s+reset\s+--hard\b/i.test(part)) return true;
  if (/\bdrop\s+table\b/i.test(part)) return true;
  return hasDestructiveRm(part);
}

/**
 * Whether a command uses another package manager.
 */
export function usesOtherPackageManager(command: string): boolean {
  return scannedParts(command).some((part) => OTHER_PM.test(part));
}

/**
 * The text a call would write.
 *
 * The host puts the content in the arguments: a write carries `content`,
 * an edit carries `newString`, and a patch carries the whole patch. A
 * patch is read for the lines it adds, so a secret in the text that is
 * being added is found.
 */
export function contentOf(event: PreToolCallEvent): string {
  const parts: string[] = [];
  for (const key of ['content', 'newString', 'text']) {
    const value = event.args[key];
    if (typeof value === 'string') parts.push(value);
  }
  for (const key of ['patchText', 'patch']) {
    const value = event.args[key];
    if (typeof value === 'string') parts.push(addedLines(value));
  }
  return parts.join('\n');
}

/**
 * The lines a patch adds.
 */
function addedLines(patch: string): string {
  return patch
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');
}
