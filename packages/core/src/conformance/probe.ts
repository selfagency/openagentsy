import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The static probes (§11).
 *
 * A probe answers one question about the host's surface, and it answers it
 * from the project's own files: the source that calls the surface, the
 * config that registers the plugin, the package that ships the bundle. So a
 * probe is a pure function of a file set, the report is the same on every
 * machine, and a test can hold a small file set and know what the probe
 * says.
 *
 * A probe never answers "observed". It answers whether the project can
 * reach the surface at all; the observation of it working is a different
 * thing, and it comes from a live session.
 */

/**
 * The project's own files, as the probes read them.
 *
 * The key is the path, relative to the workspace, with forward slashes. A
 * file the project does not have is not in the map.
 */
export type ProjectFiles = ReadonlyMap<string, string>;

/**
 * The files the probes read.
 *
 * The list is fixed, so a probe never wanders the tree and the report never
 * depends on what a directory happens to hold.
 */
export const PROBE_FILES = [
  'packages/adapter-opencode/src/v2.ts',
  'packages/adapter-opencode/src/v2-bridge.ts',
  'packages/adapter-opencode/src/v2-approval.ts',
  'packages/adapter-opencode/src/ledger-bridge.ts',
  'packages/hooks/src/shell-env.ts',
  'packages/ledger/src/ingest.ts',
  'packages/offload/src/local-detector.ts',
  'packages/offload/src/router.ts',
  'packages/sidebar/src/tui.tsx',
  'packages/sidebar/src/usage.ts',
  'packages/sidebar/src/panel.ts',
  'opencode.json',
  'opencode.jsonc',
  '.opencode/opencode.json',
  '.opencode/opencode.jsonc',
] as const;

/**
 * The plugin bundle.
 *
 * The host loads the plugins of a project from its own directory, so the
 * bundle is the proof that the plugin loads at all.
 */
export const PLUGIN_BUNDLE = '.opencode/plugins/openagentsy.js';

/**
 * Read the files the probes read.
 *
 * A file that is not there is left out of the map, and a probe that needs it
 * says the surface is not there either.
 */
export async function readProjectFiles(workspace: string): Promise<ProjectFiles> {
  const files = new Map<string, string>();
  for (const path of [...PROBE_FILES, PLUGIN_BUNDLE]) {
    const content = await readFile(join(workspace, path), 'utf8').then(
      (text) => text,
      () => undefined,
    );
    if (content !== undefined) files.set(path, content);
  }
  return files;
}

/** The text of a file, or nothing when the project does not have it. */
function fileOf(files: ProjectFiles, path: string): string | undefined {
  return files.get(path);
}

/** Whether any of the files matches the pattern. */
function anyMatch(files: ProjectFiles, pattern: RegExp): boolean {
  for (const content of files.values()) {
    if (pattern.test(content)) return true;
  }
  return false;
}

/** The characters a regular expression treats as special. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A capability with no static proof.
 *
 * Some surfaces cannot be read off the project's own files: the prompt
 * insert of the host, the schema of the host's own database. They stay
 * unverified until a session shows them working.
 */
export function alwaysFalse(_files: ProjectFiles): boolean {
  return false;
}

/**
 * The project calls the host's surface.
 *
 * The name is the path of the surface, as the code writes it: `session.family`
 * for the family of a session, `storage.store` for the durable store of the
 * TUI plugin.
 */
export function hasApi(name: string): (files: ProjectFiles) => boolean {
  const pattern = new RegExp(`${escapeRegExp(name)}(?![\\w])`);
  return (files) => anyMatch(files, pattern);
}

/**
 * The project registers the host's hook.
 *
 * The domain and the name are the two the host calls them by: `permission`
 * and `evaluate`, `shell` and `create.before`.
 */
export function hasHook(domain: string, name: string): (files: ProjectFiles) => boolean {
  const pattern = new RegExp(
    `\\.${escapeRegExp(domain)}\\.hook\\(\\s*['"\`]${escapeRegExp(name)}['"\`]`,
  );
  return (files) => anyMatch(files, pattern);
}

/**
 * The sidebar plugin claims a slot.
 *
 * The entry point of the sidebar is the file the host loads, and it claims
 * the slot it draws in.
 */
export function hasTuiEntry(files: ProjectFiles): boolean {
  const entry = fileOf(files, 'packages/sidebar/src/tui.tsx');
  if (entry === undefined) return false;
  return entry.includes('Plugin.define(') && entry.includes('ui.slot(');
}

/**
 * The plugin bundle is installed in the project.
 *
 * The host loads the plugins of a project from its own directory, so the
 * bundle is there or the plugin does not load.
 */
export function hasPluginBundle(files: ProjectFiles): boolean {
  return files.has(PLUGIN_BUNDLE);
}

/**
 * The permission key of the shell, as the project writes it.
 *
 * The key is the host's, so the project is where the answer is read: the
 * approval asks about a `shell` action, and the key in the file is the key
 * the host reads.
 */
export function hasPermissionKey(key: string): (files: ProjectFiles) => boolean {
  const pattern = new RegExp(`['"\`]${escapeRegExp(key)}['"\`]`);
  return (files) => {
    const approval = fileOf(files, 'packages/adapter-opencode/src/v2-approval.ts');
    return approval !== undefined && pattern.test(approval);
  };
}

/**
 * The offload router finds a local backend.
 *
 * The router asks the local server what it has, and the route it asks is
 * the proof that the discovery is there.
 */
export function probeBackends(files: ProjectFiles): boolean {
  const detector = fileOf(files, 'packages/offload/src/local-detector.ts');
  return detector !== undefined && detector.includes('/api/tags');
}

/**
 * The YAML hook plugins of the project.
 *
 * A YAML hook plugin is a file in the plugin directory of the project, and
 * the host loads it beside the bundles. It is named here because it is the
 * one plugin that can run after the OpenAgentsy checks without the project
 * having asked for it (§8.2).
 */
export async function readYamlHookPlugins(workspace: string): Promise<string[]> {
  const directory = join(workspace, '.opencode', 'plugins');
  const names = await readdir(directory).catch(() => [] as string[]);
  return names
    .filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'))
    .sort()
    .map((name) => `.opencode/plugins/${name}`);
}
