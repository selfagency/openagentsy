import type { V1PermissionBlock } from '@openagentsy/core';
import {
  applyShellEnvPolicy,
  baseToolName,
  createOaRegistry,
  defaultRules,
  type FileRef,
  type HookRegistry,
  type OutputFinding,
  outputCheckRules,
  type QualityMode,
  type Rule,
  toolVocabulary,
} from '@openagentsy/hooks';
import { changedFiles } from './changed-files.js';
import { mergePermissions, permissionEntriesFor } from './permission-merge.js';

/**
 * The bridge from the guardrails to the OpenCode hooks (§8.2).
 *
 * The package holds the rules; this module holds the places they are
 * checked. The table of §8.2 is the map, and every hook below is written
 * against the shape the pinned binary really fires:
 *
 * | our event | the OpenCode hook | what it does here |
 * | --- | --- | --- |
 * | PreToolCall | `tool.execute.before` | runs the rules, mutates the arguments in place, throws when a rule blocks |
 * | PostToolCall | `tool.execute.after` | rewrites what the model sees |
 * | UserPromptSubmit | `chat.message` | changes the parts of the prompt |
 * | PreCompact | `experimental.session.compacting` | adds context or replaces the prompt |
 * | PreResponse | `experimental.text.complete` | flags the text; never stops a reply |
 * | - | `shell.env` | tightens the environment of the agent's shells |
 * | - | `config` | merges the permissions that ask a person |
 *
 * Two facts from the table shape the code. The first is that the hook does
 * not fire for an MCP call on the pinned binary, so no security property
 * may depend on it: the human-only decisions are enforced by the permission
 * map (roles.yaml) and this rule is the second layer. The second is that
 * plugins run one after another on the same `output` object, so a plugin
 * loaded after ours could change the arguments after our checks pass.
 */

/** The input of a tool call, as the host hands it over. */
export type ToolCallInput = {
  /** The name the host gave the tool, prefix and all. */
  tool: string;
  /** The session the call is made in. */
  sessionID: string;
  /** The id of the call, for the approval gate. */
  callID: string;
};

/** The arguments of a tool call, as the host hands them over. */
export type ToolCallOutput = {
  /** The arguments of the call. The host holds this object. */
  args: unknown;
};

/** The output of a finished tool call. */
export type ToolResultOutput = {
  /** The title the host shows. */
  title: string;
  /** What the model sees. */
  output: string;
  /** Whatever the tool reported. */
  metadata: unknown;
};

/** The parts of a prompt, as the host hands them over. */
export type MessageOutput = {
  /** The parts of the message. */
  parts: unknown;
};

/** The output of the compaction hook. */
export type CompactingOutput = {
  /** The context lines that are added to the prompt. */
  context: string[];
  /** The prompt that replaces the default one, when it is set. */
  prompt?: string | undefined;
};

/** The output of the text hook. */
export type TextOutput = {
  /** The text the model produced. */
  text: string;
};

/** The output of the shell environment hook. */
export type ShellEnvOutput = {
  /** The environment the shell receives. */
  env: Record<string, string>;
};

/** The config the host hands to the `config` hook. */
export type HostConfig = {
  /** The permission config, when the host has one. */
  permission?: V1PermissionBlock | undefined;
};

/**
 * The hooks the bridge registers.
 *
 * Every hook is present: the host decides which of them it calls, and the
 * bridge answers for every one it declares.
 */
export type BridgeHooks = {
  'tool.execute.before': (input: ToolCallInput, output: ToolCallOutput) => Promise<void>;
  'tool.execute.after': (
    input: ToolCallInput & { args: unknown },
    output: ToolResultOutput,
  ) => Promise<void>;
  'chat.message': (
    input: { sessionID: string; agent?: string | undefined },
    output: MessageOutput,
  ) => Promise<void>;
  'experimental.session.compacting': (
    input: { sessionID: string },
    output: CompactingOutput,
  ) => Promise<void>;
  'experimental.text.complete': (input: { sessionID: string }, output: TextOutput) => Promise<void>;
  'shell.env': (
    input: { cwd: string; sessionID?: string | undefined },
    output: ShellEnvOutput,
  ) => Promise<void>;
  config: (input: HostConfig) => Promise<void>;
};

/** What the bridge needs to know. */
export type BridgeOptions = {
  /** The project the agent works in. */
  workspace: string;
  /** Where the `.openagentsy/` directory lives. */
  stateRoot: string;
  /** The role the calls of a session are made for. */
  roleForSession?: (sessionID: string) => string | undefined | Promise<string | undefined>;
  /** The paths the active task may touch, for the scope-drift check. */
  statedPaths?: readonly string[];
  /**
   * The paths the active task of a session may touch.
   *
   * The scope of a task is a fact of the board, and the board changes
   * while a session runs, so the paths are asked for per reply rather than
   * named once.
   */
  statedPathsForSession?: (sessionID: string) => readonly string[] | Promise<readonly string[]>;
  /** Where the findings of the output checks go. */
  onFindings?: (findings: OutputFinding[], sessionID: string) => void | Promise<void>;
  /** The rules a project adds on top of the defaults. */
  rules?: readonly Rule[];
  /** The commands a person has to approve. */
  approvalFor?: readonly string[];
  /**
   * The quality check, when the project runs one.
   *
   * The mode says when the check runs, and the task of a session says
   * where the findings are recorded.
   */
  quality?: {
    /** When the check runs. */
    mode: QualityMode;
    /** The task of a session, when the session has one. */
    taskIdForSession?: (sessionID: string) => string | undefined | Promise<string | undefined>;
  };
  /** Where the refusal of a permission merge goes. */
  onPermissionRefusal?: (error: Error) => void | Promise<void>;
};

/**
 * An object, when the value is one.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The base name of a tool, against the registered vocabulary.
 *
 * The prefix is not stripped by a pattern: the name is resolved by the
 * longest suffix the vocabulary knows, so `openagentsy-board_board_record`
 * is `board_record` and a rule that blocks one blocks the other.
 */
function baseNameOf(toolName: string): string {
  return baseToolName(toolName, toolVocabulary);
}

/**
 * The arguments of a call, when they are a set of named arguments.
 */
function argsOf(args: unknown): Record<string, unknown> | undefined {
  return isRecord(args) ? args : undefined;
}

/**
 * The role a call is made for.
 */
async function roleOf(options: BridgeOptions, sessionID: string): Promise<string | undefined> {
  if (options.roleForSession === undefined) return undefined;
  return await options.roleForSession(sessionID);
}

/**
 * Write the arguments a rule asked for into the call, in place.
 *
 * The host holds the object, so a new object would be thrown away: the
 * fields are written into the one the host passed in.
 *
 * And the check is not the last word: plugins run one after another on the
 * same object, so a plugin loaded after ours could change the arguments
 * after these checks pass. The lease guard is the property that does not
 * depend on this order.
 */
function applyArgsTransform(args: unknown, transform: unknown): void {
  const target = argsOf(args);
  const wanted = argsOf(transform);
  if (target === undefined || wanted === undefined) return;
  for (const [field, value] of Object.entries(wanted)) {
    target[field] = value;
  }
}

/**
 * Write what a rule asked for into the output of a finished call.
 */
function applyResultTransform(output: ToolResultOutput, transform: unknown): void {
  const wanted = argsOf(transform);
  if (wanted === undefined) return;
  const replacement = wanted['output'];
  if (typeof replacement === 'string') output.output = replacement;
  const appended = wanted['appendToResult'];
  if (typeof appended === 'string') output.output = `${output.output}\n\n${appended}`;
}

/**
 * Write the parts a rule asked for into the prompt.
 *
 * The array the host holds is changed in place, so the host sees the new
 * parts whichever way it reads them.
 */
function applyPartsTransform(output: MessageOutput, transform: unknown): void {
  const wanted = argsOf(transform);
  if (wanted === undefined) return;
  const parts = wanted['parts'];
  if (!Array.isArray(parts)) return;
  const current = output.parts;
  if (Array.isArray(current)) {
    current.splice(0, current.length, ...parts);
    return;
  }
  output.parts = parts;
}

/**
 * Write the context and the prompt a rule asked for into the compaction.
 */
function applyCompactingTransform(output: CompactingOutput, transform: unknown): void {
  const wanted = argsOf(transform);
  if (wanted === undefined) return;
  const context = wanted['context'];
  if (Array.isArray(context)) {
    for (const line of context) {
      if (typeof line === 'string') output.context.push(line);
    }
  }
  const prompt = wanted['prompt'];
  if (typeof prompt === 'string') output.prompt = prompt;
}

/**
 * The note a flag leaves on a reply.
 *
 * The checks never stop a reply: a person decides what a flag means, so the
 * flag is a note the model can see and a finding the board can hold.
 */
function annotationFor(findings: readonly OutputFinding[]): string {
  const named = [...new Set(findings.map((finding) => `${finding.name} (${finding.type})`))];
  return `[OpenAgentsy output check] this reply trips: ${named.join(', ')}.`;
}

/**
 * The rule the scope-drift check runs under.
 *
 * The check reports a file a reply names that the task does not cover, and a
 * task that states no scope has no file it does not cover: every mention
 * would be a finding, and a finding that fires on every mention says
 * nothing. So the rule is left out when the scope is not stated, and that
 * is a named rule rather than a silent filter.
 *
 * Where the scope comes from: the leases of the session's active bean, read
 * from the board. A session with no bean, or a bean that holds the whole
 * workspace, states no scope, and the check stays off for it. What would
 * turn it on everywhere: a board record that carries the paths of the
 * active task, which no board record carries today.
 */
const SCOPE_DRIFT_RULE = 'output-scope-drift';

/**
 * The rules that flag a reply.
 *
 * The scope-drift check is left out when the task's scope is not known. A
 * reply that names a file is not out of scope of a scope nobody stated, and
 * a check that fires on every mention of a path is a check that says
 * nothing: it flags the ordinary report of an ordinary change.
 */
function outputRules(
  statedPaths: readonly string[],
  sink: (findings: OutputFinding[]) => void,
): Rule[] {
  const rules = outputCheckRules({ statedPaths, onFindings: sink });
  if (statedPaths.length > 0) return rules;
  return rules.filter((rule) => rule.id !== SCOPE_DRIFT_RULE);
}

/**
 * The bridge.
 *
 * The rules are the package's: the seven defaults plus whatever a project
 * adds. The hook points are the ones the pinned binary fires.
 */
export function createBridge(options: BridgeOptions): BridgeHooks {
  const statedPaths = options.statedPaths ?? [];

  /**
   * The scope of the task a session is working on.
   *
   * The scope is asked for per reply, because the board changes while a
   * session runs. A caller that states no source has no scope, and the
   * scope-drift check stays off for that session.
   */
  async function scopeOf(sessionID: string): Promise<readonly string[]> {
    if (options.statedPathsForSession === undefined) return statedPaths;
    return await options.statedPathsForSession(sessionID);
  }

  // The rules that block. They are registered here, and the comment below
  // is the reason they are the second layer and not the first.
  //
  // No security property may depend on this hook firing for an MCP call:
  // the pinned binary does not fire it for one. The human-only decisions
  // are enforced by the permission map (roles.yaml), and this rule is the
  // defence in depth under it.
  const registry: HookRegistry = createOaRegistry([
    ...defaultRules({
      workspace: options.workspace,
      stateRoot: options.stateRoot,
      ...(options.quality === undefined ? {} : { quality: options.quality }),
    }),
    ...(options.rules ?? []),
  ]);

  /**
   * The event a tool call is fired with.
   */
  function toolEvent(
    input: ToolCallInput,
    args: unknown,
    files: FileRef[],
    role: string | undefined,
  ): Record<string, unknown> {
    return {
      type: 'PreToolCall',
      toolName: baseNameOf(input.tool),
      rawToolName: input.tool,
      args,
      files,
      sessionID: input.sessionID,
      callID: input.callID,
      ...(role === undefined ? {} : { role }),
    };
  }

  return {
    'tool.execute.before': async (input, output) => {
      const role = await roleOf(options, input.sessionID);
      const event = toolEvent(input, output.args, changedFiles(input.tool, output.args), role);
      const result = await registry.run('PreToolCall', event);
      if (!result.continue) {
        // A throw is what stops the call, and the reason is what the model
        // reads, so the reason is in the message.
        throw new Error(`OpenAgentsy blocked this call. ${result.reasons.join(' ')}`);
      }
      for (const transform of result.transformed) {
        applyArgsTransform(output.args, transform);
      }
    },

    'tool.execute.after': async (input, output) => {
      const event = toolEvent(
        { tool: input.tool, sessionID: input.sessionID, callID: input.callID },
        input.args,
        changedFiles(input.tool, input.args),
        undefined,
      );
      const result = await registry.run('PostToolCall', event);
      for (const transform of result.transformed) {
        applyResultTransform(output, transform);
      }
    },

    'chat.message': async (input, output) => {
      const result = await registry.run('UserPromptSubmit', {
        type: 'UserPromptSubmit',
        sessionID: input.sessionID,
        parts: output.parts,
      });
      for (const transform of result.transformed) {
        applyPartsTransform(output, transform);
      }
    },

    'experimental.session.compacting': async (input, output) => {
      const result = await registry.run('PreCompact', {
        type: 'PreCompact',
        sessionID: input.sessionID,
      });
      for (const transform of result.transformed) {
        applyCompactingTransform(output, transform);
      }
    },

    'experimental.text.complete': async (input, output) => {
      // The output checks are registered per call, so the findings belong to
      // the reply they were found in. A check never stops a reply.
      const findings: OutputFinding[] = [];
      const scope = await scopeOf(input.sessionID);
      const checks = createOaRegistry(
        outputRules(scope, (found) => {
          findings.push(...found);
        }),
      );
      await checks.run('PreResponse', {
        type: 'PreResponse',
        sessionID: input.sessionID,
        text: output.text,
      });
      if (findings.length === 0) return;
      await options.onFindings?.(findings, input.sessionID);
      output.text = `${output.text}\n\n${annotationFor(findings)}`;
    },

    'shell.env': async (_input, output) => {
      // The policy tightens the environment in place: the shell reads the
      // object the host filled.
      applyShellEnvPolicy(output.env);
    },

    config: async (input) => {
      const entries = permissionEntriesFor(options.approvalFor ?? []);
      if (Object.keys(entries).length === 0) return;
      try {
        input.permission = mergePermissions(input.permission ?? {}, entries);
      } catch (error) {
        // A merge that would loosen a permission is refused. The config the
        // host holds is the tighter one already, so it is left as it is and
        // the refusal goes on the record.
        const refusal =
          error instanceof Error ? error : new Error('the permission merge was refused');
        await options.onPermissionRefusal?.(refusal);
      }
    },
  };
}
