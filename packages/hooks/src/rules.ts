import { isAbsolute, resolve } from 'node:path';
import { findSecrets } from '@openagentsy/core';
import { approvalGate, createApprovalStore } from './approvals.js';
import { isReaderTool, isWritingTool, type PreToolCallEvent, readPreToolCall } from './event.js';
import {
  contentOf,
  isDestructiveCommand,
  isProtected,
  skipsGitHooks,
  usesOtherPackageManager,
} from './guards.js';
import { isInside, projectName, worktreeRoot } from './paths.js';
import { type QualityRuleOptions, qualityAfterWrite } from './quality/rule.js';
import type { HandlerResult, Rule } from './registry.js';

export {
  commandSegments,
  contentOf,
  isDestructiveCommand,
  isProtected,
  scannedParts,
  skipsGitHooks,
  substitutionPayloads,
  tokenise,
  usesOtherPackageManager,
} from './guards.js';

/**
 * The default rules.
 *
 * Seven rules, all of them checked before a tool call, and all of them
 * blocking: a call that trips one of them does not happen. The output
 * checks are the other half of the package, and they flag instead.
 *
 * The readings the rules make - the command, the path, the content of a
 * write - live in `guards.ts`, so the policy modules read the same thing
 * the rules read.
 */

/** The answer of a rule that lets the call through. */
const CONTINUE: HandlerResult = { continue: true };

/**
 * The tools a person decides with.
 *
 * The permission map denies these to every agent role, and that map is the
 * primary enforcement: the rule is the second layer, for the built-in
 * tools and for any host where the map is not the whole answer.
 */
const HUMAN_ONLY_TOOLS = ['oa_lesson_decide', 'oa_quality_waive', 'oa_memory_decide'];

/**
 * A path, made absolute against the workspace.
 *
 * A host names a file either way, and a relative path is relative to the
 * project the agent works in.
 */
function absolutePath(root: string, path: string): string {
  return isAbsolute(path) ? path : resolve(root, path);
}

/**
 * Whether a call writes a file.
 *
 * A known writing tool writes. A known reader does not, even when the
 * host says which file it read, so the exclusion cannot come back through
 * the bridge. A name that is neither is treated as a writer when the
 * call carries a file: a rule that let an unknown name through would let
 * every write the host names in an unfamiliar way through.
 */
function writesFiles(call: PreToolCallEvent): boolean {
  if (isReaderTool(call.toolName)) return false;
  if (isWritingTool(call.toolName)) return true;
  return call.files.length > 0;
}

/**
 * Whether a call writes content.
 */
function writesContent(call: PreToolCallEvent): boolean {
  if (isReaderTool(call.toolName)) return false;
  if (isWritingTool(call.toolName)) return true;
  return contentOf(call) !== '';
}

/** The options the default rules are built with. */
export interface DefaultRuleOptions {
  /** The workspace root: the project the agent works in. */
  workspace: string;
  /** The state root: where the `.openagentsy/` directory lives. */
  stateRoot: string;
  /** The home directory the worktrees live under; the home of the user by default. */
  home?: string;
  /**
   * The quality check, when the project runs one.
   *
   * A project that names no mode runs no check, so the rule is left out
   * rather than registered and idle.
   */
  quality?: Omit<QualityRuleOptions, 'workspace' | 'stateRoot'>;
}

/**
 * The seven default rules.
 *
 * They run in the order they are written, and every one of them blocks.
 */
export const defaultRules = ({
  workspace,
  stateRoot,
  home,
  quality,
}: DefaultRuleOptions): Rule[] => {
  const root = resolve(workspace);
  const roots = [root, worktreeRoot(projectName(root), home)];
  const approvals = createApprovalStore(stateRoot);
  return [
    ...(quality === undefined ? [] : [qualityAfterWrite({ workspace, stateRoot, ...quality })]),
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
        if (!usesOtherPackageManager(call.command)) return CONTINUE;
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
        if (!writesFiles(call)) return CONTINUE;
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
        if (!writesFiles(call)) return CONTINUE;
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
        if (!writesContent(call)) return CONTINUE;
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
