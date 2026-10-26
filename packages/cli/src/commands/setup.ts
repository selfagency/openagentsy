import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Target } from '@openagentsy/core';
import { applyEdits, type FormattingOptions, modify } from 'jsonc-parser';
import { PROJECT_CONFIG_NAMES } from '../opencode.js';
import { installPlugin } from '../plugin.js';

export type SetupOptions = {
  root: string;
  target: Target;
  configPath?: string;
  dryRun?: boolean;
  /**
   * Turn compaction off.
   *
   * Compaction is off for a memory integration that shrinks the context
   * itself. There is no such integration yet, so the default is OpenCode's
   * own compaction, and this flag is how a project that has one says so.
   */
  magicContext?: boolean;
};

export type SetupResult = {
  configPath: string;
  content: string;
  changed: string[];
  pluginPath?: string;
  dryRun: boolean;
  /** The config files OpenCode merges with the one that was written. */
  merged?: string[];
};

const FORMATTING: FormattingOptions = {
  insertSpaces: true,
  tabSize: 2,
  eol: '\n',
};

function setPath(text: string, path: (string | number)[], value: unknown): string {
  const edits = modify(text, path, value, { formattingOptions: FORMATTING });
  return applyEdits(text, edits);
}

async function resolveMcpCommand(root: string): Promise<string[]> {
  const dist = join(root, 'packages', 'mcp', 'dist', 'index.js');
  const built = await stat(dist).then(
    () => true,
    () => false,
  );
  if (built) {
    // A relative path keeps the config portable. The MCP server runs with the
    // project directory as its working directory, so it resolves the same way
    // on every machine. It runs under bun: the board's driver is bun:sqlite,
    // and bun is the runtime OpenCode loads plugins with, so one runtime
    // covers the plugin, the board and the tests.
    return ['bun', join('packages', 'mcp', 'dist', 'index.js')];
  }
  return ['bunx', '@openagentsy/mcp'];
}

async function findConfigPath(root: string): Promise<string> {
  for (const name of PROJECT_CONFIG_NAMES) {
    const path = join(root, name);
    const exists = await stat(path).then(
      () => true,
      () => false,
    );
    if (exists) return path;
  }
  return join(root, 'opencode.json');
}

/**
 * The config files that are already there, and would be merged with a new
 * one.
 *
 * OpenCode reads a root config and a config in the config directory, and
 * merges them. Writing a root config next to a config directory that was
 * never read is how a split brain starts.
 */
async function mergedConfigs(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of ['.opencode/opencode.json', '.opencode/opencode.jsonc']) {
    const path = join(root, name);
    const exists = await stat(path).then(
      () => true,
      () => false,
    );
    if (exists) found.push(path);
  }
  return found;
}

/**
 * Write the config shape OpenCode needs for OpenAgentsy.
 *
 * The two versions disagree on three things this touches: the MCP server
 * lives under `mcp` in V1 and `mcp.servers` in V2, the enable flag is
 * `enabled` in V1 and `disabled` in V2, and V2 turns Code Mode on by default
 * so the board tools have to be listed directly with `codemode: false`.
 */
export async function runSetup(options: SetupOptions): Promise<SetupResult> {
  const configPath = options.configPath ?? (await findConfigPath(options.root));
  const command = await resolveMcpCommand(options.root);
  const merged = await mergedConfigs(options.root);

  const text = await readFile(configPath, 'utf8').catch(() => '');

  const changed: string[] = [];
  let content = text;

  if (options.target === 'v1') {
    content = setPath(content, ['mcp', 'openagentsy'], {
      type: 'local',
      command,
      enabled: true,
    });
    changed.push('mcp.openagentsy');
    if (options.magicContext === true) {
      content = setPath(content, ['compaction', 'auto'], false);
      changed.push('compaction.auto');
      content = setPath(content, ['compaction', 'prune'], false);
      changed.push('compaction.prune');
    }
  } else {
    content = setPath(content, ['mcp', 'servers', 'openagentsy'], {
      type: 'local',
      command,
      disabled: false,
      codemode: false,
    });
    changed.push('mcp.servers.openagentsy');
    if (options.magicContext === true) {
      content = setPath(content, ['compaction', 'auto'], false);
      changed.push('compaction.auto');
    }
  }

  if (!options.dryRun) {
    await writeFile(configPath, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
  }

  const pluginPath = await installPlugin(options.root, options.dryRun ?? false);

  return {
    configPath,
    content,
    changed,
    ...(pluginPath !== undefined ? { pluginPath } : {}),
    dryRun: options.dryRun ?? false,
    ...(merged.length > 0 ? { merged } : {}),
  };
}
