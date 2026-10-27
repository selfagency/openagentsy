import { isAbsolute, resolve } from 'node:path';
import { findSecrets } from '@openagentsy/core';
import { approvalGate, createApprovalStore } from './approvals.js';
import { type PreToolCallEvent, readPreToolCall } from './event.js';
import { isInside, projectName, worktreeRoot } from './paths.js';
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
 * Git hooks cannot be skipped.
 *
 * `--no-verify` in a git segment, a bare `-n` right after `git commit`,
 * `HUSKY=0` and a `core.hooksPath` override are the same thing: the lint
 * and the typecheck do not run, and the commit is the only proof there
 * was one. The bare `-n` only counts directly after `git commit`, so a
 * commit message that talks about `-n` is not a skip.
 */
const GIT_SKIP_HOOKS =
  /\bgit\b[^|;&]*\b(commit|merge|rebase)\b[^|;&]*\s--no-verify\b|\bgit\s+commit\s+-n\b|\bHUSKY=0\b|\bcore\.hooksPath\b/;

/**
 * The package manager is Bun.
 *
 * A second package manager writes a second lockfile, and the two
 * lockfiles disagree about what the project depends on.
 */
const OTHER_PM = /(^|[\s;&|(])(pnpm|yarn|npx|npm\s+(i|install|ci|add|exec))\b/;

/**
 * The files a person changes.
 *
 * The trust boundary is wider than the roles file: the model lock and the
 * agent files are generated, the workflows run CI, the templates
 * regenerate the agents, and the lessons, the waivers and the approvals
 * are decisions.
 */
const PROTECTED_FILE =
  /(^|\/)(roles\.yaml|openagentsy\.models\.lock\.json|openagentsy\.jsonc|biome\.jsonc|turbo\.json|bunfig\.toml|bun\.lock|opencode\.json|opencode\.jsonc)$/;
const PROTECTED_DIR = /(^|\/)(\.opencode\/|\.husky\/|\.github\/workflows\/|templates\/)/;
const PROTECTED_STATE =
  /(^|\/)\.openagentsy\/(lessons\/|quality\/waivers\.json|conformance\.json|memory\.jsonl|approvals\.json)/;

/**
 * The commands that need a person to approve them.
 */
const DESTRUCTIVE = /(^|\s)(rm\s+-rf|git\s+push\s+--force|git\s+reset\s+--hard|drop\s+table)\b/i;

/**
 * The tools a person decides with.
 *
 * The permission map denies these to every agent role, and that map is the
 * primary enforcement: the rule is the second layer, for the built-in
 * tools and for any host where the map is not the whole answer.
 */
const HUMAN_ONLY_TOOLS = ['oa_lesson_decide', 'oa_quality_waive', 'oa_memory_decide'];

/**
 * Whether a path is one a person changes.
 */
export function isProtected(path: string): boolean {
  return PROTECTED_FILE.test(path) || PROTECTED_DIR.test(path) || PROTECTED_STATE.test(path);
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
}

/**
 * The seven default rules.
 *
 * They run in the order they are written, and every one of them blocks.
 */
export const defaultRules = ({ workspace, stateRoot }: DefaultRuleOptions): Rule[] => {
  const root = resolve(workspace);
  const roots = [root, worktreeRoot(projectName(root))];
  const approvals = createApprovalStore(stateRoot);
  return [
    {
      id: 'no-skip-git-hooks',
      event: 'PreToolCall',
      block: true,
      handler: (event) => {
        const call = readPreToolCall(event);
        if (call === undefined || call.command === undefined) return CONTINUE;
        if (!GIT_SKIP_HOOKS.test(call.command)) return CONTINUE;
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
        if (call === undefined || call.files.length === 0) return CONTINUE;
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
      handler: approvalGate(DESTRUCTIVE, approvals),
    },
  ];
};
