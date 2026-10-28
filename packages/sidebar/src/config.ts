import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ModelArch,
  type PrefillCoeff,
  type Range,
  type Registry,
  r,
  resolveArch,
  resolveSite,
  type SiteProfile,
  type Throughput,
  WORLD_REGION,
} from '@openagentsy/footprint';

/**
 * The footprint configuration of a project.
 *
 * The EcoLogits data is not bundled anywhere in this repository, because its
 * licence has not been verified, so every number the estimator needs comes
 * from the project: the model map, the provider sites, the grid factors and
 * the throughput. The project writes them in `openagentsy.jsonc`, under
 * `footprint`, and this module reads them.
 *
 * A project that configures nothing gets a configuration that estimates
 * nothing, and the block stays hidden. That is the honest answer: a number
 * without a grid factor and a throughput would be a guess.
 */

/** The name of the project's config file. */
const PROJECT_CONFIG_NAME = 'openagentsy.jsonc';

/** The providers that run on the machine in front of the person. */
const DEFAULT_LOCAL_PROVIDERS = ['ollama', 'ollama-local', 'lmstudio', 'lm-studio'] as const;

/** A pair of bounds, as it is written in the config. */
export type Bounds = readonly [number, number];

/** The grid of one region: the carbon and the water of a kilowatt-hour. */
export interface GridEntry {
  readonly kgCo2PerKWh: Bounds;
  readonly wueLPerKWh: Bounds;
}

/** The size of one model, in billions of parameters. */
export interface ModelEntry {
  readonly totalParamsB: Bounds;
  readonly activeParamsB?: Bounds;
}

/** How fast one model generates. */
export interface ThroughputEntry {
  readonly ttftS: Bounds;
  readonly tps: Bounds;
}

/** What a provider discloses about its own infrastructure. */
export interface ProviderEntry {
  readonly pue: Bounds;
  readonly wueOnSite: Bounds;
}

/** The coefficients of the prefill term, the OpenAgentsy extension. */
export interface PrefillEntry {
  readonly kIn: Bounds;
  readonly kCache: Bounds;
}

/** The `footprint` section of `openagentsy.jsonc`, as it is written. */
export interface FootprintConfigData {
  readonly showWarming?: boolean;
  readonly region?: string;
  readonly localDeviceWatts?: Bounds;
  readonly prefill?: boolean;
  readonly prefillCoeff?: PrefillEntry;
  readonly localProviders?: readonly string[];
  readonly grid?: Readonly<Record<string, GridEntry>>;
  readonly models?: Readonly<Record<string, ModelEntry>>;
  readonly throughput?: Readonly<Record<string, ThroughputEntry>>;
  readonly providers?: Readonly<Record<string, ProviderEntry>>;
}

/**
 * The configuration the blocks read.
 *
 * The site and the throughput answer with nothing when the project has not
 * configured them, because a block that shows a number it cannot back is
 * worse than a block that shows none.
 */
export interface FootprintConfig {
  /** Whether the warming is shown. The plan says it is, unless a project says otherwise. */
  readonly showWarming: boolean;
  /** The region whose grid factors are used. */
  readonly region: string;
  /** The power of the local device, when the project knows it. */
  readonly localDeviceWatts: Range | undefined;
  /** Whether the prefill term is on. It is off by default. */
  readonly prefill: boolean;
  /** The coefficients of the prefill term. */
  readonly prefillCoeff: PrefillCoeff;
  /** The providers that run locally. */
  readonly localProviders: readonly string[];
  /** What is known about a model. */
  readonly arch: (provider: string, model: string) => ModelArch;
  /** The site of a provider, when the grid factors are configured. */
  readonly site: (provider: string) => SiteProfile | undefined;
  /** How fast a model generates, when the project configured it. */
  readonly throughput: (provider: string, model: string) => Throughput | undefined;
}

/** The registry the footprint package resolves against. */
function buildRegistry(data: FootprintConfigData): Registry {
  const ecologitsModels = new Map<string, ModelArch>();
  const overrides = new Map<string, ModelArch>();

  for (const [key, entry] of Object.entries(data.models ?? {})) {
    const arch: ModelArch = {
      totalParamsB: r(...entry.totalParamsB),
      activeParamsB: entry.activeParamsB ? r(...entry.activeParamsB) : r(...entry.totalParamsB),
      source: 'user',
    };
    overrides.set(key, arch);
    const slash = key.indexOf('/');
    if (slash !== -1) overrides.set(key.slice(slash + 1), arch);
  }

  const providerSites = new Map<string, SiteProfile>();
  for (const [key, entry] of Object.entries(data.providers ?? {})) {
    providerSites.set(key, {
      pue: r(...entry.pue),
      wueOnSite: r(...entry.wueOnSite),
      wueOffSite: r(0),
      gridKgCo2PerKWh: r(0),
      source: `user:${key}`,
      disclosed: true,
    });
  }

  const grid = new Map<string, Range>();
  const offsiteWue = new Map<string, Range>();
  for (const [key, entry] of Object.entries(data.grid ?? {})) {
    grid.set(key, r(...entry.kgCo2PerKWh));
    offsiteWue.set(key, r(...entry.wueLPerKWh));
  }

  return { ecologitsModels, overrides, providerSites, grid, offsiteWue };
}

/** The configuration the blocks read, built from what the project wrote. */
export function buildFootprintConfig(data: FootprintConfigData): FootprintConfig {
  const region = data.region ?? WORLD_REGION;
  const registry = buildRegistry(data);
  const hasGrid = registry.grid.has(region) && registry.offsiteWue.has(region);

  const throughputs = new Map<string, Throughput>();
  for (const [key, entry] of Object.entries(data.throughput ?? {})) {
    throughputs.set(key, { ttftS: r(...entry.ttftS), tps: r(...entry.tps) });
  }

  const prefill = data.prefill ?? false;
  const prefillCoeff: PrefillCoeff = data.prefillCoeff
    ? { kIn: r(...data.prefillCoeff.kIn), kCache: r(...data.prefillCoeff.kCache) }
    : { kIn: r(0), kCache: r(0) };

  return {
    showWarming: data.showWarming ?? true,
    region,
    localDeviceWatts: data.localDeviceWatts ? r(...data.localDeviceWatts) : undefined,
    prefill,
    prefillCoeff,
    localProviders: data.localProviders ?? DEFAULT_LOCAL_PROVIDERS,
    arch: (provider, model) => resolveArch(registry, provider, model),
    site: (provider) => (hasGrid ? resolveSite(registry, provider, region) : undefined),
    throughput: (provider, model) =>
      throughputs.get(`${provider}/${model}`) ?? throughputs.get(model),
  };
}

/** Whether a provider runs on the machine in front of the person. */
export function isLocalProvider(config: FootprintConfig, provider: string): boolean {
  return config.localProviders.includes(provider);
}

/** A value that is an object, when it is one. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** A pair of finite numbers, when the value is one. */
function asBounds(value: unknown): Bounds | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const lo = value[0];
  const hi = value[1];
  if (typeof lo !== 'number' || typeof hi !== 'number') return undefined;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return undefined;
  return [lo, hi];
}

/**
 * The entries of a config section, keeping the ones that are complete.
 *
 * Every section of the footprint config is a map from a key to an object of
 * bounds, and an entry that is incomplete is dropped rather than guessed.
 */
function readEntries<T>(
  value: unknown,
  build: (record: Record<string, unknown>) => T | undefined,
): Record<string, T> {
  const raw = asRecord(value);
  const out: Record<string, T> = {};
  if (!raw) return out;
  for (const [key, entry] of Object.entries(raw)) {
    const record = asRecord(entry);
    if (!record) continue;
    const built = build(record);
    if (built) out[key] = built;
  }
  return out;
}

/** The grid entries of a config, keeping the ones that are complete. */
function readGrid(value: unknown): Record<string, GridEntry> {
  return readEntries(value, (record) => {
    const kgCo2PerKWh = asBounds(record['kgCo2PerKWh']);
    const wueLPerKWh = asBounds(record['wueLPerKWh']);
    if (!kgCo2PerKWh || !wueLPerKWh) return undefined;
    return { kgCo2PerKWh, wueLPerKWh };
  });
}

/** The model entries of a config, keeping the ones that are complete. */
function readModels(value: unknown): Record<string, ModelEntry> {
  return readEntries(value, (record) => {
    const totalParamsB = asBounds(record['totalParamsB']);
    if (!totalParamsB) return undefined;
    const activeParamsB = asBounds(record['activeParamsB']);
    return activeParamsB ? { totalParamsB, activeParamsB } : { totalParamsB };
  });
}

/** The throughput entries of a config, keeping the ones that are complete. */
function readThroughput(value: unknown): Record<string, ThroughputEntry> {
  return readEntries(value, (record) => {
    const ttftS = asBounds(record['ttftS']);
    const tps = asBounds(record['tps']);
    if (!ttftS || !tps) return undefined;
    return { ttftS, tps };
  });
}

/** The provider entries of a config, keeping the ones that are complete. */
function readProviders(value: unknown): Record<string, ProviderEntry> {
  return readEntries(value, (record) => {
    const pue = asBounds(record['pue']);
    const wueOnSite = asBounds(record['wueOnSite']);
    if (!pue || !wueOnSite) return undefined;
    return { pue, wueOnSite };
  });
}

/** The prefill coefficients of a config, when they are complete. */
function readPrefill(value: unknown): PrefillEntry | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const kIn = asBounds(record['kIn']);
  const kCache = asBounds(record['kCache']);
  if (!kIn || !kCache) return undefined;
  return { kIn, kCache };
}

/** The `footprint` section of a parsed config, as the blocks read it. */
function readFootprintData(value: unknown): FootprintConfigData {
  const raw = asRecord(value);
  if (!raw) return {};

  const data: {
    showWarming?: boolean;
    region?: string;
    localDeviceWatts?: Bounds;
    prefill?: boolean;
    prefillCoeff?: PrefillEntry;
    localProviders?: string[];
    grid?: Record<string, GridEntry>;
    models?: Record<string, ModelEntry>;
    throughput?: Record<string, ThroughputEntry>;
    providers?: Record<string, ProviderEntry>;
  } = {};

  if (typeof raw['showWarming'] === 'boolean') data.showWarming = raw['showWarming'];
  if (typeof raw['region'] === 'string') data.region = raw['region'];
  if (typeof raw['prefill'] === 'boolean') data.prefill = raw['prefill'];

  const localDeviceWatts = asBounds(raw['localDeviceWatts']);
  if (localDeviceWatts) data.localDeviceWatts = localDeviceWatts;

  const prefillCoeff = readPrefill(raw['prefillCoeff']);
  if (prefillCoeff) data.prefillCoeff = prefillCoeff;

  if (Array.isArray(raw['localProviders'])) {
    const providers = raw['localProviders'].filter(
      (entry): entry is string => typeof entry === 'string',
    );
    if (providers.length > 0) data.localProviders = providers;
  }

  data.grid = readGrid(raw['grid']);
  data.models = readModels(raw['models']);
  data.throughput = readThroughput(raw['throughput']);
  data.providers = readProviders(raw['providers']);

  return data;
}

/** The end of a string, the closing quote included. */
function endOfString(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === '"') return index + 1;
    index += 1;
  }
  return index;
}

/** Whether the comma at an index is a trailing one. */
function isTrailingComma(text: string, index: number): boolean {
  let ahead = index + 1;
  while (ahead < text.length && /\s/.test(text[ahead] ?? '')) ahead += 1;
  const following = text[ahead];
  return following === '}' || following === ']';
}

/**
 * The index after the comment or the trailing comma at an index.
 *
 * The answer is -1 when the character at the index is none of them, so the
 * scanner can keep its loop to one decision.
 */
function skip(text: string, index: number): number {
  const char = text[index] ?? '';
  if (char === '/' && text[index + 1] === '/') {
    const end = text.indexOf('\n', index);
    return end === -1 ? text.length : end;
  }
  if (char === '/' && text[index + 1] === '*') {
    const end = text.indexOf('*/', index + 2);
    return end === -1 ? text.length : end + 2;
  }
  if (char === ',' && isTrailingComma(text, index)) {
    return index + 1;
  }
  return -1;
}

/**
 * Strip the comments and the trailing commas of a JSONC file.
 *
 * A comment marker inside a string is text, so the scanner reads the
 * strings first: a URL in a config is not a comment.
 */
function stripJsonc(text: string): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? '';
    if (char === '"') {
      const end = endOfString(text, index);
      out += text.slice(index, end);
      index = end;
      continue;
    }
    const skipped = skip(text, index);
    if (skipped !== -1) {
      index = skipped;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/** The parsed project config, when the project has one that can be read. */
async function readProjectConfig(root: string): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(join(root, PROJECT_CONFIG_NAME), 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(text));
  } catch {
    return undefined;
  }
  return asRecord(parsed);
}

/**
 * The footprint configuration of a project.
 *
 * A project without the file, or with a file that is not JSON, gets a
 * configuration that estimates nothing: the block stays hidden rather than
 * showing a number nobody can back.
 */
export async function readFootprintConfig(root: string): Promise<FootprintConfig> {
  const config = await readProjectConfig(root);
  return buildFootprintConfig(readFootprintData(config?.['footprint']));
}
