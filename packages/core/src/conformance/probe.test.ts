import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  alwaysFalse,
  hasApi,
  hasHook,
  hasPermissionKey,
  hasPluginBundle,
  hasTuiEntry,
  PLUGIN_BUNDLE,
  type ProjectFiles,
  probeBackends,
  readProjectFiles,
  readYamlHookPlugins,
} from './probe.js';

let root: string;

/** The file set of a workspace that holds nothing. */
function filesOf(entries: Record<string, string>): ProjectFiles {
  return new Map(Object.entries(entries));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openagentsy-conformance-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Write a file of the workspace. */
async function write(relative: string, content: string): Promise<void> {
  const path = join(root, relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

describe('the static probes', () => {
  it('finds the surface the project calls, and only that one', () => {
    const files = filesOf({ 'packages/sidebar/src/usage.ts': 'context.data.session.family(id);' });
    expect(hasApi('data.session.family')(files)).toBe(true);
    expect(hasApi('data.session.message')(files)).toBe(false);
  });

  it('finds the hook the project registers, and only that one', () => {
    const files = filesOf({
      'packages/adapter-opencode/src/v2.ts':
        "await ctx.shell.hook('create.before', async (e) => {});",
    });
    expect(hasHook('shell', 'create.before')(files)).toBe(true);
    expect(hasHook('shell', 'create.after')(files)).toBe(false);
    expect(hasHook('permission', 'create.before')(files)).toBe(false);
  });

  it('wants the sidebar entry that claims a slot', () => {
    expect(hasTuiEntry(filesOf({ 'packages/sidebar/src/tui.tsx': 'Plugin.define({});' }))).toBe(
      false,
    );
    expect(
      hasTuiEntry(
        filesOf({
          'packages/sidebar/src/tui.tsx': 'Plugin.define({ setup(c) { c.ui.slot({}); } });',
        }),
      ),
    ).toBe(true);
  });

  it('wants the bundle the host loads', () => {
    expect(hasPluginBundle(filesOf({}))).toBe(false);
    expect(hasPluginBundle(filesOf({ [PLUGIN_BUNDLE]: 'export default {};' }))).toBe(true);
  });

  it('reads the permission key out of the approval', () => {
    const files = filesOf({
      'packages/adapter-opencode/src/v2-approval.ts': "export const SHELL_ACTION = 'shell';",
    });
    expect(hasPermissionKey('shell')(files)).toBe(true);
    expect(hasPermissionKey('bash')(files)).toBe(false);
  });

  it('wants the route the router asks for a local model', () => {
    const files = filesOf({
      'packages/offload/src/local-detector.ts': "probePath: '/api/tags',",
    });
    expect(probeBackends(files)).toBe(true);
    expect(probeBackends(filesOf({}))).toBe(false);
  });

  it('proves nothing for a surface with no proof', () => {
    expect(alwaysFalse(filesOf({ 'packages/sidebar/src/tui.tsx': 'Plugin.define({});' }))).toBe(
      false,
    );
  });
});

describe('reading the files of a project', () => {
  it('reads the files the probes read, and leaves out the ones that are not there', async () => {
    await write('packages/sidebar/src/tui.tsx', 'Plugin.define({});');
    const files = await readProjectFiles(root);
    expect(files.get('packages/sidebar/src/tui.tsx')).toBe('Plugin.define({});');
    expect(files.has('packages/offload/src/local-detector.ts')).toBe(false);
  });

  it('names the YAML hook plugins of the project', async () => {
    await write('.opencode/plugins/openagentsy.js', 'export default {};');
    await write('.opencode/plugins/hooks.yaml', 'hooks: []');
    await write('.opencode/plugins/notes.txt', 'not a plugin');
    expect(await readYamlHookPlugins(root)).toEqual(['.opencode/plugins/hooks.yaml']);
  });

  it('has no YAML hook plugin in a project without one', async () => {
    expect(await readYamlHookPlugins(root)).toEqual([]);
  });
});
