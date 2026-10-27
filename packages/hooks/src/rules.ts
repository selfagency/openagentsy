import { isAbsolute, resolve } from 'node:path';
import { findSecrets } from '@openagentsy/core';
import { approvalGate, createApprovalStore } from './approvals.js';
import { type PreToolCallEvent, readPreToolCall } from './event.js';
import { isInside, pathSegments, projectName, worktreeRoot } from './paths.js';
import type { HandlerResult, Rule } from './registry.js';

/**
 * The default rules.
 *
 * Seven rules, all of them checked before a tool call, and all of them
 * blocking: a call that trips one of them does not happen. The output
 * checks are the other half of the package, and they flag instead.
 */

/** The answer of a rule that lets the call through. */
const CONTINUE: HandlerResult = { continue: true };

/**
 * The command with its quoted text taken out.
 *
 * A message can hold anything, including the text of the rule that is
 * looking for it: `git commit -m "docs: note --no-verify"` is a commit
 * whose message talks about the flag. The quotes are stripped first, so
 * the rule reads the command and not the message.
 */
export function stripQuoted(command: string): string {
  return command.replace(/'[^']*'/g, ' ').replace(/"[^"]*"/g, ' ');
}

/** A short flag cluster: `-n`, `-nm`, `-an`. */
const SHORT_FLAG = /(?:^|\s)-([A-Za-z]+)/g;

/**
 * Whether a command skips the git hooks.
 *
 * The `-n` of `git commit` is the short form of `--no-verify`, and it is
 * caught in any position of the command: `git commit -n`,
 * `git commit -m "wip" -n`, `git commit -a -n` and `git commit -nm "wip"`
 * all skip the hooks. The long flag is read in the segment that names the
 * git command, and the quoted text is taken out first, so a commit whose
 * message talks about the flag is still a commit.
 */
export function skipsGitHooks(command: string): boolean {
  const bare = stripQuoted(command);
  if (/\bHUSKY=0\b/.test(bare)) return true;
  if (/\bcore\.hooksPath\b/.test(bare)) return true;
  for (const segment of bare.split(/[|;&]/)) {
    if (!/\bgit\b[^|;&]*\b(commit|merge|rebase)\b/.test(segment)) continue;
    if (/--no-verify\b/.test(segment)) return true;
    for (const match of segment.matchAll(SHORT_FLAG)) {
      const cluster = match[1];
      if (cluster?.includes('n')) return true;
    }
  }
  return false;
}

/**
 * The package manager is Bun.
 *
 * A second package manager writes a second lockfile, and the two
 * lockfiles disagree about what the project depends on. The name is
 * caught wherever it is written, so a path to another package manager is
 * caught too.
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

/** The state a person changes, under the state root. */
const PROTECTED_STATE = [
  '.openagentsy/lessons',
  '.openagentsy/quality/waivers.json',
  '.openagentsy/conformance.json',
  '.openagentsy/memory.jsonl',
  '.openagentsy/approvals.json',
];

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
  return false;
}

/**
 * The tools a person decides with.
 *
 * The permission map denies these to every agent role, and that map is the
 * primary enforcement: the rule is the second layer, for the built-in
 * tools and for any host where the map is not the whole answer.
 */
const HUMAN_ONLY_TOOLS = ['oa_lesson_decide', 'oa_quality_waive', 'oa_memory_decide'];

/**
 * Whether a flag makes a removal destructive.
 *
 * `rm` takes its flags in any order and in either spelling: `-rf`, `-fr`,
 * `-r -f` and `--recursive --force` are the same command.
 */
function isDestructiveFlag(flag: string): boolean {
  if (flag.startsWith('--')) return flag === '--recursive' || flag === '--force';
  const letters = flag.slice(1);
  return letters.includes('r') || letters.includes('f');
}

/**
 * Whether a segment holds a destructive `rm`.
 */
function hasDestructiveRm(segment: string): boolean {
  const tokens = segment.split(/\s+/).filter((token) => token.length > 0);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (!/(^|\/)rm$/.test(token)) continue;
    for (let next = index + 1; next < tokens.length; next += 1) {
      const flag = tokens[next];
      if (flag === undefined || !flag.startsWith('-')) break;
      if (isDestructiveFlag(flag)) return true;
    }
  }
  return false;
}

/**
 * Whether a command destroys something.
 *
 * The command is split on the separators, so a destructive command behind
 * a `;`, an `&&` or a `|` is still one, and the flags of `rm` are read in
 * any order and in either spelling.
 */
export function isDestructiveCommand(command: string): boolean {
  const bare = stripQuoted(command);
  if (/\bgit\s+push\s+--force\b/i.test(bare)) return true;
  if (/\bgit\s+reset\s+--hard\b/i.test(bare)) return true;
  if (/\bdrop\s+table\b/i.test(bare)) return true;
  return bare.split(/[|;&\n]+/).some((segment) => hasDestructiveRm(segment));
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

/**
 * A path, made absolute against the workspace.
 *
 * A host names a file either way, and a relative path is relative to the
 * project the agent works in.
 */
function absolutePath(root: string, path: string): string {
  return isAbsolute(path) ? path : resolve(root, path);
}

/** The options the default rules are built with. */
export interface DefaultRuleOptions {
  /** The workspace root: the project the agent works in. */
  workspace: string;
  /** The state root: where the `.openagentsy/` directory lives. */
  stateRoot: string;
  /** The home directory the worktrees live under; the home of the user by default. */
  home?: string;
}

/**
 * The seven default rules.
 *
 * They run in the order they are written, and every one of them blocks.
 */
export const defaultRules = ({ workspace, stateRoot, home }: DefaultRuleOptions): Rule[] => {
  const root = resolve(workspace);
  const roots = [root, worktreeRoot(projectName(root), home)];
  const approvals = createApprovalStore(stateRoot);
  return [
    {
      id: 'no-skip-git-hooks',
      event: 'PreToolCall',
      block: true,
      handler: (event) => {
        const call = readPreToolCall(event);
        if (call === undefined || call.command === undefined) return CONTINUE;
        if (!skipsGitHooks(call.command)) return CONTINUE;
        return {
          continue: false,
          reason: 'Git hooks (lint, typecheck) cannot be skipped. Fix the reported errors instead.',
        };
      },
    },
    {
      id: 'package-manager',
      event: 'PreToolCall',
      block: true,
      handler: (event) => {
        const call = readPreToolCall(event);
        if (call === undefined || call.command === undefined) return CONTINUE;
        if (!OTHER_PM.test(call.command)) return CONTINUE;
        return {
          continue: false,
          reason:
            'This repo uses Bun. Use `bun add` / `bun remove` / `bunx`, or `turbo run <task>`.',
        };
      },
    },
    {
      id: 'workspace-writes-only',
      event: 'PreToolCall',
      block: true,
      handler: (event) => {
        const call = readPreToolCall(event);
        if (call === undefined) return CONTINUE;
        const outside = call.files.some((file) =>
          [file.path, file.fromPath]
            .filter((path): path is string => path !== undefined)
            .some((path) => !isInside(absolutePath(root, path), roots)),
        );
        if (!outside) return CONTINUE;
        return {
          continue: false,
          reason: 'Writes are limited to the workspace and OpenAgentsy worktrees.',
        };
      },
    },
    {
      id: 'protect-policy',
      event: 'PreToolCall',
      block: true,
      handler: (event) => {
        const call = readPreToolCall(event);
        if (call === undefined) return CONTINUE;
        const touched = call.files.some(
          (file) =>
            (file.path !== undefined && isProtected(file.path)) ||
            (file.fromPath !== undefined && isProtected(file.fromPath)),
        );
        if (!touched) return CONTINUE;
        return {
          continue: false,
          reason:
            'Policy, role, permission, build-config, lockfile, hook, workflow, lesson and waiver files are changed by a person (or, for bun.lock, by `bun add`; for roles.yaml and templates, by running the generator). Propose the change in chat.',
        };
      },
    },
    {
      id: 'human-only-decisions',
      event: 'PreToolCall',
      block: true,
      handler: (event) => {
        const call = readPreToolCall(event);
        if (call === undefined) return CONTINUE;
        const tool = call.toolName;
        const humanOnly = HUMAN_ONLY_TOOLS.some(
          (name) => tool === name || tool.endsWith(`_${name}`),
        );
        if (!humanOnly) return CONTINUE;
        return {
          continue: false,
          reason:
            'Lesson decisions, quality waivers and memory promotions are recorded by a person (/oa lesson, /oa waive, /oa memory). Propose it in chat with your evidence.',
        };
      },
    },
    {
      id: 'secret-scan-writes',
      event: 'PreToolCall',
      block: true,
      handler: (event) => {
        const call = readPreToolCall(event);
        if (call === undefined) return CONTINUE;
        const content = contentOf(call);
        if (content === '') return CONTINUE;
        if (findSecrets(content).length === 0) return CONTINUE;
        return {
          continue: false,
          reason:
            'The content contains what looks like a credential. Use an env var or secret reference.',
        };
      },
    },
    {
      id: 'destructive-needs-approval',
      event: 'PreToolCall',
      block: true,
      handler: approvalGate(isDestructiveCommand, approvals),
    },
  ];
};
