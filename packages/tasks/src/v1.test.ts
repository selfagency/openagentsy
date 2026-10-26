import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { taskToolNames } from './tools.js';
import { findBeansConfig, OpenAgentsyTasks, openStore } from './v1.js';

/**
 * The plugin: the store, the tools and the block.
 *
 * The hooks are driven with the output objects the host would hand over,
 * because that is the whole contract: the block goes into the system
 * prompt on every message, and into the context when a session is
 * compacted. Nothing here writes a configuration file, so a test can call
 * the factory and find the world as it was.
 */

/** A project with a `.beans.yml` and two tasks in it. */
const project = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'oa-tasks-plugin-'));
  await writeFile(
    join(root, '.beans.yml'),
    'project:\n  name: demo\nbeans:\n  path: .beans\n  prefix: demo-\n  id_length: 4\n',
    'utf8',
  );
  const beans = join(root, '.beans');
  await mkdir(beans, { recursive: true });
  await writeFile(
    join(beans, 'demo-1111--a-task.md'),
    '---\n# demo-1111\ntitle: A task of the project\nstatus: todo\ntype: task\n---\n\nIts body.\n',
    'utf8',
  );
  return root;
};

describe('the plugin', () => {
  it('pushes the prime block into the system prompt', async () => {
    const plugin = await OpenAgentsyTasks({ directory: await project() });
    const output = { system: [] as string[] };
    await plugin['experimental.chat.system.transform']?.({}, output);
    expect(output.system).toHaveLength(1);
    expect(output.system[0]).toContain('## Project tasks (.beans)');
    expect(output.system[0]).toContain('demo-1111');
  });

  it('pushes the prime block into the compaction context', async () => {
    const plugin = await OpenAgentsyTasks({ directory: await project() });
    const output = { context: [] as string[] };
    await plugin['experimental.session.compacting']?.({}, output);
    expect(output.context).toHaveLength(1);
    expect(output.context[0]).toContain('## Project tasks (.beans)');
  });

  it('registers the task tools', async () => {
    const plugin = await OpenAgentsyTasks({ directory: await project() });
    expect(Object.keys(plugin.tool ?? {}).sort()).toEqual([...taskToolNames].sort());
  });

  it('finds the configuration above the directory it is given', async () => {
    const root = await project();
    const nested = join(root, 'packages', 'thing');
    await mkdir(nested, { recursive: true });
    const config = await findBeansConfig(nested);
    expect(config?.directory).toBe(root);
    expect(config?.path).toBe('.beans');
    expect(config?.prefix).toBe('demo-');
    expect(config?.idLength).toBe(4);
  });

  it('opens the store of the project, not of the directory it was given', async () => {
    const root = await project();
    const nested = join(root, 'packages', 'thing');
    await mkdir(nested, { recursive: true });

    const store = await openStore(nested);
    expect(store.root).toBe(join(root, '.beans'));

    const plugin = await OpenAgentsyTasks({ directory: nested });
    const output = { system: [] as string[] };
    await plugin['experimental.chat.system.transform']?.({}, output);
    expect(output.system[0]).toContain('demo-1111');
  });

  it('falls back to the defaults when there is no configuration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-tasks-bare-'));
    const store = await openStore(root);
    expect(store.root).toBe(join(root, '.beans'));
    expect(store.prefix).toBe('oa-');
  });
});
