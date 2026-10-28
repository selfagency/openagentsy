import {
  CAPABILITIES,
  type Capability,
  type ConformanceHost,
  type ConformanceState,
  VOIDED_CAPABILITIES,
  type VoidedCapability,
} from './capabilities.js';
import {
  type EvidenceEntry,
  hasLiveObservation,
  mergeObservations,
  type Observation,
  observationsFor,
  readEvidence,
} from './evidence.js';
import {
  PLUGIN_BUNDLE,
  type ProjectFiles,
  readProjectFiles,
  readYamlHookPlugins,
} from './probe.js';
import { SEED_OBSERVATIONS } from './seed.js';

/**
 * The conformance report (§11).
 *
 * The report says, per capability, what the project knows about a surface of
 * the host. A capability is `observed` when a live session showed it
 * working, `proven_static` when the project's own files or the host's
 * schema show it is there, and `unverified` when neither is the case.
 *
 * The report never writes. The state of a capability is read from the
 * evidence store and from the static probe, and a probe cannot produce an
 * observation, so a probe can never upgrade a check to `observed`.
 */

/** What the report says about one capability. */
export type CapabilityReport = {
  /** The name the capability is known by. */
  id: string;
  /** The host the capability belongs to. */
  host: ConformanceHost;
  /** The state the capability is in. */
  state: ConformanceState;
  /** What the capability is, in one line. */
  title: string;
  /** The section of the plan the capability settles, when it settles one. */
  verifyRef?: string | undefined;
  /** The event that would witness the capability working. */
  observeOn: readonly string[];
  /** The evidence the state rests on. */
  evidence: readonly Observation[];
  /** Whether the project's own files show the surface is there. */
  probe: boolean;
};

/**
 * A warning about the order the plugins load in.
 *
 * A plugin that loads after the OpenAgentsy one can change what the
 * OpenAgentsy checks have already passed, so a person has to know it is
 * there.
 */
export type PluginOrderWarning = {
  /** The plugin the warning is about. */
  plugin: string;
  /** What the warning says. */
  detail: string;
};

/** The report. */
export type ConformanceReport = {
  /** When the report was built. */
  generatedAt: string;
  /** One entry per capability. */
  capabilities: readonly CapabilityReport[];
  /** How many capabilities are in each state. */
  counts: {
    total: number;
    observed: number;
    proven_static: number;
    unverified: number;
  };
  /** The warnings about the order the plugins load in. */
  pluginOrderWarnings: readonly PluginOrderWarning[];
  /** The V1 capabilities the plan lists and the project does not have. */
  voided: readonly VoidedCapability[];
  /** Where the evidence of the project lives. */
  evidencePath: string;
  /** Whether the evidence file was on disk. */
  evidenceOnDisk: boolean;
  /** Why the evidence file could not be read, when it could not be read. */
  evidenceError?: string | undefined;
};

/** What the report is built from. */
export type ConformanceOptions = {
  /** The workspace: the project's own directory. */
  workspace: string;
  /** The state root: where the evidence of the project lives. */
  stateRoot: string;
  /** The moment the report is stamped with, when a caller holds one. */
  now?: string | undefined;
};

/**
 * The state of a capability.
 *
 * A live observation puts it in `observed`. A schema observation or a
 * passing probe puts it in `proven_static`, and the schema observation is
 * what says the surface exists without saying it was seen working. Neither
 * leaves it in `unverified`.
 */
export function stateOf(
  capability: Capability,
  observations: readonly Observation[],
  files: ProjectFiles,
): ConformanceState {
  if (hasLiveObservation(observations)) return 'observed';
  if (observations.length > 0) return 'proven_static';
  return capability.probeStatic(files) ? 'proven_static' : 'unverified';
}

/** The plugin entries a config file names. */
function pluginEntriesOf(text: string): string[] {
  const array = /"plugin"\s*:\s*\[([^\]]*)\]/.exec(text);
  if (array === null) return [];
  const body = array[1];
  if (body === undefined) return [];
  const entries: string[] = [];
  const pattern = /"([^"]+)"/g;
  for (;;) {
    const found = pattern.exec(body);
    if (found === null) break;
    const entry = found[1];
    if (entry !== undefined) entries.push(entry);
  }
  return entries;
}

/**
 * The warnings about the plugins a config file names.
 *
 * A config file can name the OpenAgentsy bundle and other plugins beside
 * it. A plugin that is named beside ours can register a hook of its own.
 */
function configPluginWarnings(files: ProjectFiles): PluginOrderWarning[] {
  const warnings: PluginOrderWarning[] = [];
  for (const [path, content] of files) {
    if (!path.endsWith('.json') && !path.endsWith('.jsonc')) continue;
    for (const entry of pluginEntriesOf(content)) {
      if (entry === PLUGIN_BUNDLE || entry.includes('openagentsy')) continue;
      warnings.push({
        plugin: entry,
        detail: `${entry} is loaded beside the OpenAgentsy plugin, so a hook of its own can run after the OpenAgentsy checks`,
      });
    }
  }
  return warnings;
}

/**
 * The warnings about the YAML hook plugins.
 *
 * A YAML hook plugin is loaded the same way a bundle is, and it is the one
 * the plan names: a YAML hook plugin runs after the OpenAgentsy checks.
 */
function yamlHookWarnings(yamlHooks: readonly string[]): PluginOrderWarning[] {
  return yamlHooks.map((hook) => ({
    plugin: hook,
    detail: `${hook} is a YAML hook plugin, and a YAML hook plugin runs after the OpenAgentsy checks`,
  }));
}

/**
 * The warnings about the order the plugins load in.
 *
 * The OpenAgentsy bundle is loaded from the plugin directory of the project,
 * and a plugin that is named beside it in a config file can register a hook
 * of its own. A YAML hook plugin is loaded the same way, and it is the one
 * the plan names: a YAML hook plugin runs after the OpenAgentsy checks.
 */
export function pluginOrderWarnings(
  files: ProjectFiles,
  yamlHooks: readonly string[],
): PluginOrderWarning[] {
  const warnings: PluginOrderWarning[] = [];
  const seen = new Set<string>();
  for (const warning of [...configPluginWarnings(files), ...yamlHookWarnings(yamlHooks)]) {
    if (seen.has(warning.plugin)) continue;
    seen.add(warning.plugin);
    warnings.push(warning);
  }
  return warnings;
}

/** The observations of a capability: the seed first, then the file. */
function observationsOf(
  capabilityId: string,
  entries: readonly EvidenceEntry[],
): readonly Observation[] {
  const seeded = SEED_OBSERVATIONS.filter(
    (observation) => observation.capabilityId === capabilityId,
  );
  const recorded = observationsFor(entries, capabilityId);
  return mergeObservations(seeded, recorded);
}

/**
 * Build the report.
 *
 * The probes read the project's own files, the evidence comes from the
 * store, and nothing is written.
 */
export async function buildConformanceReport(
  options: ConformanceOptions,
): Promise<ConformanceReport> {
  const files = await readProjectFiles(options.workspace);
  const yamlHooks = await readYamlHookPlugins(options.workspace);
  const store = await readEvidence(options.stateRoot);

  const capabilities: CapabilityReport[] = CAPABILITIES.map((capability) => {
    const evidence = observationsOf(capability.id, store.entries);
    return {
      id: capability.id,
      host: capability.host,
      state: stateOf(capability, evidence, files),
      title: capability.title,
      ...(capability.verifyRef === undefined ? {} : { verifyRef: capability.verifyRef }),
      observeOn: capability.observeOn,
      evidence,
      probe: capability.probeStatic(files),
    };
  });

  const counts = {
    total: capabilities.length,
    observed: capabilities.filter((entry) => entry.state === 'observed').length,
    proven_static: capabilities.filter((entry) => entry.state === 'proven_static').length,
    unverified: capabilities.filter((entry) => entry.state === 'unverified').length,
  };

  return {
    generatedAt: options.now ?? new Date().toISOString(),
    capabilities,
    counts,
    pluginOrderWarnings: pluginOrderWarnings(files, yamlHooks),
    voided: VOIDED_CAPABILITIES,
    evidencePath: store.path,
    evidenceOnDisk: store.onDisk,
    ...(store.error === undefined ? {} : { evidenceError: store.error }),
  };
}
