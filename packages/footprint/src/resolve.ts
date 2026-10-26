import { type ModelArch, type Range, r, type SiteProfile } from './types.js';

/**
 * Everything the estimator needs to know, injected.
 *
 * Nothing is loaded from a file: the model map, the grid factors and the
 * provider sites all come from the caller, because the data behind them has
 * licenses this package cannot ship.
 */
export interface Registry {
  /** The model map, keyed by the normalised model id. */
  ecologitsModels: Map<string, ModelArch>;
  /** The user's own numbers, keyed by `provider/modelId` or by `modelId`. */
  overrides: Map<string, ModelArch>;
  /** The provider sites, keyed by provider. */
  providerSites: Map<string, SiteProfile>;
  /** Kilograms of CO2 per kWh, by region. */
  grid: Map<string, Range>;
  /** Litres per kWh of embedded water, by region. */
  offsiteWue: Map<string, Range>;
}

/** The region key that means "the world, when nobody says". */
export const WORLD_REGION = 'WORLD';

/** What a provider discloses about its own infrastructure. */
export interface ProviderDefaults {
  pue: Range;
  wueOnSite: Range;
  source: string;
  disclosed: boolean;
}

/**
 * The provider table of the EcoLogits methodology.
 *
 * The numbers are the ones EcoLogits uses for these providers. A provider
 * that is not in the table gets the widest range in it, marked as not
 * disclosed, because guessing a narrow one would be a lie.
 */
const PROVIDER_TABLE: Record<string, ProviderDefaults> = {
  anthropic: {
    pue: r(1.09, 1.14),
    wueOnSite: r(0.13, 0.99),
    source: 'ecologits:anthropic',
    disclosed: true,
  },
  google: {
    pue: r(1.09),
    wueOnSite: r(0.99),
    source: 'ecologits:google',
    disclosed: true,
  },
  mistral: {
    pue: r(1.16),
    wueOnSite: r(0.09),
    source: 'ecologits:mistral',
    disclosed: true,
  },
  openai: {
    pue: r(1.2),
    wueOnSite: r(0.569),
    source: 'ecologits:openai',
    disclosed: true,
  },
};

/** The names EcoLogits itself uses, which are not the names in the table. */
const PROVIDER_ALIASES: Record<string, string> = {
  google_genai: 'google',
  mistralai: 'mistral',
};

/**
 * The widest PUE range in the table, with the widest WUE range.
 *
 * A provider that discloses nothing gets these, and they are marked as not
 * disclosed so the UI can say so.
 */
const UNDISCLOSED: ProviderDefaults = {
  pue: r(1.09, 1.14),
  wueOnSite: r(0.13, 0.99),
  source: 'world-default',
  disclosed: false,
};

/** What a provider discloses about its own infrastructure. */
export function providerDefaults(provider: string): ProviderDefaults {
  const key = PROVIDER_ALIASES[provider] ?? provider;
  return PROVIDER_TABLE[key] ?? UNDISCLOSED;
}

/**
 * The model id in the form the model map is keyed by.
 *
 * A model id may carry its provider (`ollama/qwen3:8b`) and it may be
 * written in any case, so the key is the name alone, in lower case.
 */
export function normalizeModelId(modelId: string): string {
  const trimmed = modelId.trim().toLowerCase();
  const slash = trimmed.indexOf('/');
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

/**
 * What is known about a model.
 *
 * A user's own number wins over the model map, because the person writing
 * it knows more than any table. A model nobody describes gets a very wide
 * range, so the answer says "model size unknown" instead of pretending.
 */
export function resolveArch(reg: Registry, provider: string, modelId: string): ModelArch {
  return (
    reg.overrides.get(`${provider}/${modelId}`) ??
    reg.overrides.get(modelId) ??
    reg.ecologitsModels.get(normalizeModelId(modelId)) ?? {
      totalParamsB: r(10, 2000),
      activeParamsB: r(1, 600),
      source: 'unknown',
    }
  );
}

/**
 * The site of a provider in a region.
 *
 * The provider's own PUE and cooling water come from the table, or from the
 * registry when the caller knows better. The grid's carbon and water come
 * from the registry, which is injected, and a region nobody has a number
 * for falls back to the world.
 */
export function resolveSite(reg: Registry, provider: string, region: string): SiteProfile {
  const injected = reg.providerSites.get(provider);
  const site = injected ?? providerDefaults(provider);

  const grid = reg.grid.get(region) ?? reg.grid.get(WORLD_REGION);
  if (!grid) {
    throw new Error(
      `no grid carbon factor for "${region}" and no "${WORLD_REGION}" in the registry`,
    );
  }
  const offsite = reg.offsiteWue.get(region) ?? reg.offsiteWue.get(WORLD_REGION);
  if (!offsite) {
    throw new Error(
      `no off-site water factor for "${region}" and no "${WORLD_REGION}" in the registry`,
    );
  }

  return {
    pue: site.pue,
    wueOnSite: site.wueOnSite,
    wueOffSite: offsite,
    gridKgCo2PerKWh: grid,
    source: site.source,
    disclosed: site.disclosed,
  };
}
