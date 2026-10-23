import { fileURLToPath } from 'node:url';
import type { RolesFile } from '@openagentsy/core';
import { buildSurfaceIndex, loadBenchLm } from './benchlm.js';
import { assembleCandidates } from './candidates.js';
import { buildLock } from './lock.js';
import { loadModelsDev } from './modelsdev.js';
import { loadAliases, loadPolicy } from './policy.js';
import { type FetchLike, listProviderModels, type ProviderSelection } from './providers.js';

export const POLICY_PATH = fileURLToPath(new URL('../policy/providers.yaml', import.meta.url));
export const ALIASES_PATH = fileURLToPath(
  new URL('../policy/benchlm-aliases.yaml', import.meta.url),
);

export type SelectModelsInput = {
  root: string;
  roles: RolesFile;
  providers: ProviderSelection[];
  fetchImpl?: FetchLike;
  now?: number;
  benchLmKey?: string;
  allowTraining?: boolean;
  allowRetention?: boolean;
  date?: string;
};

export type SelectModelsResult = {
  lock: ReturnType<typeof buildLock>['lock'];
  reasons: Record<string, string>;
  failures: Record<string, string>;
  rejected: Record<string, ReturnType<typeof buildLock>['rejected'][string]>;
  sources: { modelsDev: string; benchlm: string };
  counts: { served: number; candidates: number; ranked: number };
};

/**
 * Pick a model for every role from live provider inventories, the models.dev
 * catalog, the BenchLM leaderboard and the checked in retention policy.
 */
export async function selectModels(input: SelectModelsInput): Promise<SelectModelsResult> {
  const fetchImpl = input.fetchImpl ?? fetch;

  const [modelsDev, benchLm, policy, aliasFile] = await Promise.all([
    loadModelsDev(input.root, {
      fetchImpl,
      ...(input.now !== undefined ? { now: input.now } : {}),
    }),
    loadBenchLm(input.root, {
      fetchImpl,
      ...(input.now !== undefined ? { now: input.now } : {}),
      ...(input.benchLmKey !== undefined ? { key: input.benchLmKey } : {}),
    }),
    loadPolicy(POLICY_PATH),
    loadAliases(ALIASES_PATH),
  ]);

  const served: Record<string, string[]> = {};
  const inventories = await Promise.all(
    input.providers.map(async (selection) => {
      const models = await listProviderModels(selection, fetchImpl);
      return [
        selection.provider,
        models.map((model) => (typeof model === 'string' ? model : model.name)),
      ] as const;
    }),
  );
  for (const [provider, models] of inventories) {
    served[provider] = models;
  }

  const candidates = assembleCandidates({
    providers: input.providers,
    served,
    modelsDev: modelsDev.catalog,
    benchLmIndex: buildSurfaceIndex(benchLm.catalog),
    aliases: aliasFile.aliases,
    policy,
  });

  const { lock, reasons, rejected, failures } = buildLock({
    roles: input.roles,
    candidates,
    providers: input.providers.map((selection) => selection.provider),
    ...(input.allowTraining !== undefined ? { allowTraining: input.allowTraining } : {}),
    ...(input.allowRetention !== undefined ? { allowRetention: input.allowRetention } : {}),
    ...(input.date !== undefined ? { date: input.date } : {}),
  });

  const ranked = candidates.filter((candidate) => candidate.ranks.coding !== undefined).length;

  return {
    lock,
    reasons,
    failures,
    rejected,
    sources: { modelsDev: modelsDev.source, benchlm: benchLm.source },
    counts: {
      served: Object.values(served).reduce((total, list) => total + list.length, 0),
      candidates: candidates.length,
      ranked,
    },
  };
}
