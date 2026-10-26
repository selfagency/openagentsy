import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { toolMap } from '@openagentsy/adapter-opencode';
import { parse as parseYaml } from 'yaml';
import { DEFAULT_LENGTH, DEFAULT_PREFIX } from './ids.js';
import { primeBlock } from './prime.js';
import { TaskStore } from './store.js';
import { taskTools } from './tools.js';

/**
 * The plugin: the store, the tools, and the prime block.
 *
 * This is a library export. Nothing here writes a configuration file or
 * registers itself anywhere: the caller decides where the plugin runs. The
 * hooks are the ones the V1 plugin API defines, and both of them push the
 * prime block, so a session knows the state of the tasks from its first
 * message and still knows it after a compaction.
 */

/** The V1 plugin shape, with the hooks this plugin uses. */
export interface TasksPlugin {
  'experimental.chat.system.transform'?: (
    input: unknown,
    output: { system: string[] },
  ) => Promise<void>;
  'experimental.session.compacting'?: (
    input: unknown,
    output: { context: string[] },
  ) => Promise<void>;
  tool?: Record<string, unknown>;
}

/** What `.beans.yml` says about the store. */
export interface BeansConfig {
  /** The directory the configuration is in, and the project it belongs to. */
  directory: string;
  /** The directory the task files live in, relative to the project. */
  path: string;
  /** The prefix every new id carries. */
  prefix: string;
  /** The number of random characters in an id. */
  idLength: number;
}

/**
 * The plugin.
 *
 * The store is opened once, when the plugin is set up, and the block is
 * rendered from it on every message.
 */
export const OpenAgentsyTasks = async (input: { directory: string }): Promise<TasksPlugin> => {
  const store = await openStore(input.directory);
  const prime = async (): Promise<string> => primeBlock(await store.all());

  return {
    'experimental.chat.system.transform': async (_input, output) => {
      output.system.push(await prime());
    },
    'experimental.session.compacting': async (_input, output) => {
      output.context.push(await prime());
    },
    tool: toolMap(taskTools(store)),
  };
};

/**
 * The store of a project.
 *
 * The configuration is found by walking up from the directory, the way the
 * tools that write configuration files find the project they belong to.
 */
export async function openStore(directory: string): Promise<TaskStore> {
  const config = await findBeansConfig(directory);
  // The store belongs to the project the configuration is in, not to the
  // directory the caller happened to name: a plugin opened on a directory
  // inside a project reads that project's tasks.
  const root = join(config?.directory ?? resolve(directory), config?.path ?? '.beans');
  return new TaskStore(root, {
    prefix: config?.prefix ?? DEFAULT_PREFIX,
    ...(config?.idLength === undefined ? {} : { idLength: config.idLength }),
  });
}

/**
 * The `.beans.yml` of the project the directory belongs to.
 *
 * The file is optional: a project without one gets the defaults, which are
 * the ones Beans uses.
 */
export async function findBeansConfig(directory: string): Promise<BeansConfig | undefined> {
  let current = resolve(directory);
  for (;;) {
    const config = await readConfig(current);
    if (config) return config;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** The configuration of a directory, if the directory has one. */
async function readConfig(directory: string): Promise<BeansConfig | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(directory, '.beans.yml'), 'utf8');
  } catch {
    return undefined;
  }
  if (raw === '') return undefined;
  return configOf(raw, directory);
}

/** The configuration a file says. */
function configOf(raw: string, directory: string): BeansConfig {
  const parsed = (parseYaml(raw) ?? {}) as Record<string, unknown>;
  const beans = (parsed.beans ?? {}) as Record<string, unknown>;
  return {
    directory,
    path: typeof beans.path === 'string' ? beans.path : '.beans',
    prefix: typeof beans.prefix === 'string' ? beans.prefix : DEFAULT_PREFIX,
    idLength: typeof beans.id_length === 'number' ? beans.id_length : DEFAULT_LENGTH,
  };
}
