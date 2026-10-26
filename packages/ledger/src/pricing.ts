import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The pricing chain (§6.3).
 *
 * The reported cost of a message wins, then models.dev, then LiteLLM, then
 * OpenRouter, and then nothing: a model nobody prices stays unpriced and is
 * shown as unpriced, never as zero dollars. A zero would be a lie about
 * money, and a report that says "free" is a report nobody can act on.
 */

/** The token counts of one message. */
export type TokenCounts = {
  input: number;
  output: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
};

/** The rates of a band, per million tokens. */
export type Rates = {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
};

/**
 * A band of the pricing.
 *
 * `above` is the number of input tokens the band starts at. A source with
 * no tiers has one band, from zero upwards.
 */
export type Tier = Rates & { above: number };

/** Where a price came from. */
export type PriceSource = 'reported' | 'models.dev' | 'litellm' | 'openrouter' | 'none';

export type PriceResult = {
  /** The price in dollars, or null when no source knows it. */
  cost: number | null;
  source: PriceSource;
  /** The bands that priced it. */
  tiers?: Tier[];
};

export type PriceOptions = {
  /** The cost OpenCode reported, when it reported one. */
  reportedCost?: number | null;
  /** Where the cached sources live. */
  cacheDir?: string;
  /** The fetch to use, so a test does not need the network. */
  fetchImpl?: FetchLike;
  /** How long a fetch may take. */
  timeoutMs?: number;
  /** The clock, so a test can age a cache file. */
  now?: () => number;
  /** Where the bundled snapshot lives. */
  snapshotDir?: string;
};

/**
 * The fetch the chain uses.
 *
 * It is not the global `fetch` type, because a test hands in a plain
 * function and the global one carries properties a double does not have.
 */
export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

/** How long a cached source stays fresh. */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** How long a fetch may take before the chain moves on. */
export const FETCH_TIMEOUT_MS = 10_000;

/** A number, from a number or a numeric string. */
function num(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The rates of one entry, with its bands. */
function toTiers(value: unknown): Tier[] | null {
  const entry = record(value);
  const input = num(entry.input);
  const output = num(entry.output);
  if (input === 0 && output === 0) return null;

  const cacheRead = num(entry.cacheRead);
  const cacheWrite = num(entry.cacheWrite);
  const tiers: Tier[] = [
    {
      above: 0,
      input,
      output,
      ...(cacheRead > 0 ? { cacheRead } : {}),
      ...(cacheWrite > 0 ? { cacheWrite } : {}),
    },
  ];

  const extra = Array.isArray(entry.tiers) ? entry.tiers : [];
  for (const band of extra) {
    const b = record(band);
    const bandInput = num(b.input);
    const bandOutput = num(b.output);
    if (bandInput === 0 && bandOutput === 0) continue;
    const bandCacheRead = num(b.cacheRead);
    const bandCacheWrite = num(b.cacheWrite);
    tiers.push({
      above: num(b.above),
      input: bandInput,
      output: bandOutput,
      ...(bandCacheRead > 0 ? { cacheRead: bandCacheRead } : {}),
      ...(bandCacheWrite > 0 ? { cacheWrite: bandCacheWrite } : {}),
    });
  }

  return tiers.sort((a, b) => a.above - b.above);
}

/** The band that applies to a request of this many input tokens. */
function applicableTier(tiers: Tier[], inputTokens: number): Tier | undefined {
  let chosen: Tier | undefined;
  for (const tier of tiers) {
    if (tier.above > inputTokens) continue;
    if (chosen === undefined || tier.above > chosen.above) chosen = tier;
  }
  return chosen;
}

/**
 * The price of the tokens.
 *
 * A band prices the whole request: a source that raises its rate above a
 * threshold charges the higher rate for everything once the threshold is
 * passed, which is what the providers do.
 */
function costOf(tiers: Tier[], tokens: TokenCounts): number | null {
  const tier = applicableTier(tiers, tokens.input);
  if (tier === undefined) return null;
  const output = tokens.output + (tokens.reasoning ?? 0);
  const cost =
    (tokens.input * tier.input +
      output * tier.output +
      (tokens.cacheRead ?? 0) * (tier.cacheRead ?? 0) +
      (tokens.cacheWrite ?? 0) * (tier.cacheWrite ?? 0)) /
    1_000_000;
  return Number.isFinite(cost) && cost >= 0 ? cost : null;
}

/** The models.dev shape: a provider, then its models, then their rates. */
function reduceModelsDev(raw: unknown): unknown {
  const out: Record<string, Record<string, Rates>> = {};
  for (const [providerId, provider] of Object.entries(record(raw))) {
    const models = record(record(provider).models);
    const rates: Record<string, Rates> = {};
    for (const [modelId, model] of Object.entries(models)) {
      const cost = record(record(model).cost);
      const input = num(cost.input);
      const output = num(cost.output);
      if (input === 0 && output === 0) continue;
      const cacheRead = num(cost.cache_read);
      const cacheWrite = num(cost.cache_write);
      rates[modelId] = {
        input,
        output,
        ...(cacheRead > 0 ? { cacheRead } : {}),
        ...(cacheWrite > 0 ? { cacheWrite } : {}),
      };
    }
    if (Object.keys(rates).length > 0) out[providerId] = rates;
  }
  return out;
}

/** The LiteLLM shape: a model key, per-token rates, and its bands. */
function reduceLiteLLM(raw: unknown): unknown {
  const out: Record<string, Rates & { tiers?: Tier[] }> = {};
  for (const [key, entry] of Object.entries(record(raw))) {
    const model = record(entry);
    const input = num(model.input_cost_per_token) * 1_000_000;
    const output = num(model.output_cost_per_token) * 1_000_000;
    if (input === 0 && output === 0) continue;
    const cacheRead = num(model.cache_read_input_token_cost) * 1_000_000;
    const cacheWrite = num(model.cache_creation_input_token_cost) * 1_000_000;
    const tiers = liteLlmBands(model);
    out[key] = {
      input,
      output,
      ...(cacheRead > 0 ? { cacheRead } : {}),
      ...(cacheWrite > 0 ? { cacheWrite } : {}),
      ...(tiers.length > 0 ? { tiers } : {}),
    };
  }
  return out;
}

/**
 * The bands of a LiteLLM entry.
 *
 * The bands live in the key names: a rate above a threshold is spelled
 * `input_cost_per_token_above_128k_tokens`, and the rate for the output
 * sits under the same suffix.
 */
function liteLlmBands(entry: Record<string, unknown>): Tier[] {
  const bands: Tier[] = [];
  for (const [key, value] of Object.entries(entry)) {
    const match = /^input_cost_per_token_above_(\d+)(k?)_tokens$/.exec(key);
    if (match === null) continue;
    const rate = num(value);
    if (rate === 0) continue;
    const count = Number(match[1]);
    const above = match[2] === 'k' ? count * 1000 : count;
    const output =
      num(entry[key.replace('input_cost_per_token', 'output_cost_per_token')]) * 1_000_000;
    const cacheRead =
      num(entry[key.replace('input_cost_per_token', 'cache_read_input_token_cost')]) * 1_000_000;
    const cacheWrite =
      num(entry[key.replace('input_cost_per_token', 'cache_creation_input_token_cost')]) *
      1_000_000;
    bands.push({
      above,
      input: rate * 1_000_000,
      output,
      ...(cacheRead > 0 ? { cacheRead } : {}),
      ...(cacheWrite > 0 ? { cacheWrite } : {}),
    });
  }
  return bands.sort((a, b) => a.above - b.above);
}

/** The OpenRouter shape: a model id, per-token rates as strings. */
function reduceOpenRouter(raw: unknown): unknown {
  const out: Record<string, Rates> = {};
  const data = record(raw).data;
  if (!Array.isArray(data)) return out;
  for (const model of data) {
    const entry = record(model);
    const id = readString(entry.id);
    if (id === undefined) continue;
    const pricing = record(entry.pricing);
    const input = num(pricing.prompt) * 1_000_000;
    const output = num(pricing.completion) * 1_000_000;
    if (input === 0 && output === 0) continue;
    const cacheRead = num(pricing.input_cache_read) * 1_000_000;
    const cacheWrite = num(pricing.input_cache_write) * 1_000_000;
    out[id] = {
      input,
      output,
      ...(cacheRead > 0 ? { cacheRead } : {}),
      ...(cacheWrite > 0 ? { cacheWrite } : {}),
    };
  }
  return out;
}

/** One source of the chain. */
export type Source = {
  name: PriceSource;
  /** The file the source is cached in. */
  file: string;
  url: string;
  reduce: (raw: unknown) => unknown;
  lookup: (payload: unknown, provider: string, model: string) => Tier[] | null;
};

/** The chain, in order. The first hit wins. */
export const SOURCES: readonly Source[] = [
  {
    name: 'models.dev',
    file: 'models.dev',
    url: 'https://models.dev/api.json',
    reduce: reduceModelsDev,
    lookup: (payload, provider, model) => {
      const providers = record(payload);
      const own = record(providers[provider]);
      const hit = toTiers(own[model]);
      if (hit !== null) return hit;
      // The provider id of the host and the one of the catalogue do not
      // always match, so a model is looked up again under every provider.
      for (const providerId of Object.keys(providers).sort()) {
        const found = toTiers(record(providers[providerId])[model]);
        if (found !== null) return found;
      }
      return null;
    },
  },
  {
    name: 'litellm',
    file: 'litellm',
    url: 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json',
    reduce: reduceLiteLLM,
    lookup: (payload, provider, model) => {
      const entries = record(payload);
      return toTiers(entries[model] ?? entries[`${provider}/${model}`]);
    },
  },
  {
    name: 'openrouter',
    file: 'openrouter',
    url: 'https://openrouter.ai/api/v1/models',
    reduce: reduceOpenRouter,
    lookup: (payload, provider, model) => {
      const entries = record(payload);
      return toTiers(entries[`${provider}/${model}`] ?? entries[model]);
    },
  },
];

/** Where the cached sources live. */
export function defaultCacheDir(): string {
  return join(homedir(), '.cache', 'openagentsy', 'pricing');
}

/** Where the bundled snapshot lives. */
export function defaultSnapshotDir(): string {
  return fileURLToPath(new URL('../data/pricing/', import.meta.url));
}

function readJsonFile(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/** The cached payload, when the file is there and fresh. */
function readFresh(path: string, now: number): unknown | null {
  try {
    const stats = statSync(path);
    if (now - stats.mtimeMs >= CACHE_TTL_MS) return null;
  } catch {
    return null;
  }
  return readJsonFile(path);
}

/**
 * The payload of one source.
 *
 * The disk cache comes first and lasts a day, then the network, and then the
 * bundled snapshot, so an offline machine still prices what it can.
 */
async function loadSource(source: Source, options: PriceOptions): Promise<unknown | null> {
  const cacheDir = options.cacheDir ?? defaultCacheDir();
  const cached = readFresh(join(cacheDir, `${source.file}.json`), options.now?.() ?? Date.now());
  if (cached !== null) return cached;

  const fetched = await fetchSource(source, options);
  if (fetched !== null) {
    try {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(join(cacheDir, `${source.file}.json`), JSON.stringify(fetched), 'utf8');
    } catch {
      // The cache is a convenience. A cache that cannot be written is not a
      // reason to lose the price.
    }
    return fetched;
  }

  const snapshotDir = options.snapshotDir ?? defaultSnapshotDir();
  const snapshot = join(snapshotDir, `${source.file}.json`);
  return existsSync(snapshot) ? readJsonFile(snapshot) : null;
}

/** The source, fetched and reduced. Null when the fetch fails. */
async function fetchSource(source: Source, options: PriceOptions): Promise<unknown | null> {
  const doFetch: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const timeout = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  try {
    const response = await doFetch(source.url, { signal: AbortSignal.timeout(timeout) });
    if (!response.ok) return null;
    const payload: unknown = await response.json();
    return source.reduce(payload);
  } catch {
    return null;
  }
}

/**
 * The price of a message.
 *
 * The reported cost of the message wins, because the host knows what it
 * charged. After that the chain runs, and when every source fails the
 * result is a null cost and the source `none`: unpriced, not free.
 */
export async function priceMessage(
  provider: string,
  model: string,
  tokens: TokenCounts,
  options: PriceOptions = {},
): Promise<PriceResult> {
  const reported = options.reportedCost;
  if (typeof reported === 'number' && Number.isFinite(reported) && reported > 0) {
    return { cost: reported, source: 'reported' };
  }

  for (const source of SOURCES) {
    const payload = await loadSource(source, options);
    if (payload === null) continue;
    const tiers = source.lookup(payload, provider, model);
    if (tiers === null) continue;
    const cost = costOf(tiers, tokens);
    if (cost === null) continue;
    return { cost, source: source.name, tiers };
  }

  return { cost: null, source: 'none' };
}
