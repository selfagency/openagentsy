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
 * It does not cover: the shell. A payload behind a construct this matcher
 * does not read - an alias, a function, a here-document, a variable - is
 * not seen. A name the matcher does not know is treated as a writer, not
 * as a reader.
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
