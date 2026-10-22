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

/**
 * Join the four sources into one list of candidates: what the provider
 * serves, what the model can do, how it ranks, and what its terms are.
 */
export function assembleCandidates(input: AssembleInput): Candidate[] {
  const candidates: Candidate[] = [];

  for (const selection of input.providers) {
    const provider = selection.provider;
    const ids = input.served[provider] ?? [];

    for (const id of ids) {
      const meta = modelsDevEntry(input.modelsDev, provider, id);
      const openCodeId = `${provider}/${id}`;

      const alias = input.aliases[openCodeId];
      const ranks = ranksFor(
        input.benchLmIndex,
        {
          ...(meta?.canonical_model_id !== undefined
            ? { canonicalId: meta.canonical_model_id }
            : {}),
          id,
          name: meta?.name ?? id,
        },
        alias,
      );

      const benchEntry = ranks.overall ?? ranks.coding ?? ranks.agentic;
      const isOllama = provider === 'ollama' || provider === 'ollama-cloud';
      const creator = creatorOf(meta, benchEntry);

      const model: ProviderModel = {
        provider,
        id,
        openCodeId,
        name: meta?.name ?? id,
        tools: isOllama ? (meta?.tool_call ?? true) : (meta?.tool_call ?? false),
        thinking: isOllama ? (meta?.reasoning ?? true) : (meta?.reasoning ?? false),
        vision: meta?.attachment ?? false,
        reasoning: meta?.reasoning ?? false,
        variants: (meta?.reasoning_options ?? [])
          .filter((option) => option.type === 'effort')
          .flatMap((option) => option.values ?? []),
        ...(meta?.limit?.context !== undefined ? { contextWindow: meta.limit.context } : {}),
        ...(meta?.cost?.input !== undefined && meta.cost.output !== undefined
          ? {
              cost: {
                input: meta.cost.input,
                output: meta.cost.output,
                ...(meta.cost.cache_read !== undefined ? { cacheRead: meta.cost.cache_read } : {}),
              },
            }
          : {}),
        ...(meta?.canonical_model_id !== undefined ? { canonicalId: meta.canonical_model_id } : {}),
        ...(creator !== undefined ? { creator } : {}),
        ...(meta?.release_date !== undefined ? { releaseDate: meta.release_date } : {}),
      };

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
