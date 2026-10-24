import type { SurfaceEntry } from './benchlm.js';
import { ranksFor } from './benchlm.js';
import type { ModelsDevCatalog, ModelsDevModel } from './modelsdev.js';
import { type PolicyFile, quotaFor, retentionFor } from './policy.js';
import type { ProviderSelection } from './providers.js';
import type { Candidate, ProviderId, ProviderModel, Surface } from './types.js';

export type AssembleInput = {
  providers: ProviderSelection[];
  /** The model ids each provider serves, keyed by provider. */
  served: Record<string, string[]>;
  modelsDev: ModelsDevCatalog;
  benchLmIndex: Map<Surface, Map<string, SurfaceEntry>>;
  aliases: Record<string, string>;
  policy: PolicyFile;
};

function stripTag(name: string): string {
  const index = name.indexOf(':');
  return index === -1 ? name : name.slice(0, index);
}

function modelsDevEntry(
  catalog: ModelsDevCatalog,
  provider: ProviderId,
  id: string,
): ModelsDevModel | undefined {
  const providerEntry = catalog[provider];
  if (!providerEntry) return undefined;
  const direct = providerEntry.models[id];
  if (direct) return direct;
  const stripped = stripTag(id);
  return providerEntry.models[stripped];
}

function creatorOf(
  model: ModelsDevModel | undefined,
  benchLm: { creator?: string } | undefined,
): string | undefined {
  return benchLm?.creator ?? model?.name;
}

function variantsOf(meta: ModelsDevModel | undefined): string[] {
  return (meta?.reasoning_options ?? [])
    .filter((option) => option.type === 'effort')
    .flatMap((option) => option.values ?? []);
}

function costOf(meta: ModelsDevModel | undefined): ProviderModel['cost'] {
  if (meta?.cost?.input === undefined || meta.cost.output === undefined) return undefined;
  return {
    input: meta.cost.input,
    output: meta.cost.output,
    ...(meta.cost.cache_read !== undefined ? { cacheRead: meta.cost.cache_read } : {}),
  };
}

/** The object's entries that are defined, so a spread stays type-safe without a ternary. */
function defined<T extends object>(object: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<T>;
}

/** The model one provider id serves, with its capabilities and terms. */
function providerModelOf(
  provider: ProviderId,
  id: string,
  meta: ModelsDevModel | undefined,
  creator: string | undefined,
): ProviderModel {
  const isOllama = provider === 'ollama' || provider === 'ollama-cloud';
  const fallback = isOllama;
  return {
    provider,
    id,
    openCodeId: `${provider}/${id}`,
    name: meta?.name ?? id,
    tools: meta?.tool_call ?? fallback,
    thinking: meta?.reasoning ?? fallback,
    vision: meta?.attachment ?? false,
    reasoning: meta?.reasoning ?? false,
    variants: variantsOf(meta),
    ...(defined({
      contextWindow: meta?.limit?.context,
      cost: costOf(meta),
      canonicalId: meta?.canonical_model_id,
      creator,
      releaseDate: meta?.release_date,
    }) as Pick<
      ProviderModel,
      'contextWindow' | 'cost' | 'canonicalId' | 'creator' | 'releaseDate'
    >),
  };
}

/** The ranks one model has, by its canonical id, its id, its name and its alias. */
function ranksOf(
  input: AssembleInput,
  provider: ProviderId,
  id: string,
  meta: ModelsDevModel | undefined,
) {
  const alias = input.aliases[`${provider}/${id}`];
  return ranksFor(
    input.benchLmIndex,
    {
      ...(meta?.canonical_model_id !== undefined ? { canonicalId: meta.canonical_model_id } : {}),
      id,
      name: meta?.name ?? id,
    },
    alias,
  );
}

/**
 * Join the four sources into one list of candidates: what the provider
 * serves, what the model can do, how it ranks, and what its terms are.
 */
export function assembleCandidates(input: AssembleInput): Candidate[] {
  const candidates: Candidate[] = [];

  for (const selection of input.providers) {
    const provider = selection.provider;

    for (const id of input.served[provider] ?? []) {
      const meta = modelsDevEntry(input.modelsDev, provider, id);
      const ranks = ranksOf(input, provider, id, meta);
      const benchEntry = ranks.overall ?? ranks.coding ?? ranks.agentic;
      const creator = creatorOf(meta, benchEntry);

      const model = providerModelOf(provider, id, meta, creator);
      const retention = retentionFor(input.policy, provider, id);
      const quota = quotaFor(input.policy, provider, id);

      candidates.push({
        model,
        ranks,
        retention,
        ...(quota ? { quota } : {}),
      });
    }
  }

  return candidates;
}
