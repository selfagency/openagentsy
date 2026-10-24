import { fileURLToPath } from 'node:url';
import type { RolesFile } from '@openagentsy/core';
import { buildSurfaceIndex, loadBenchLm } from './benchlm.js';
import { assembleCandidates } from './candidates.js';
import { buildLock } from './lock.js';
import { loadModelsDev } from './modelsdev.js';
import { loadAliases, loadPolicy } from './policy.js';
import { type FetchLike, listProviderModels, type ProviderSelection } from './providers.js';
import { withFlashPreference } from './score.js';
import { type ModelLock, PROVIDER_IDS, type ProviderId } from './types.js';

export const POLICY_PATH = fileURLToPath(new URL('../policy/providers.yaml', import.meta.url));
export const ALIASES_PATH = fileURLToPath(
  new URL('../policy/benchlm-aliases.yaml', import.meta.url),
);

type ProviderAlias = {
  /** The provider the alias names. */
  provider: ProviderId;
  /** What the alias means, so the choice is visible instead of guessed. */
  means: string;
};

/**
 * The names a person may type for a provider.
 *
 * The alias `ollama` is the cloud provider, because the local one is not a
 * provider OpenCode can run. The local one is `ollama-local`.
 *
 * The provider ids do not move with the aliases: the policy file names
 * `ollama` for the provider on this machine and `ollama-cloud` for the cloud
 * one, and the lock records ids and not names.
 */
const PROVIDER_ALIASES: Record<string, ProviderAlias> = {
  opencode: { provider: 'opencode', means: 'the OpenCode Zen models' },
  zen: { provider: 'opencode', means: 'the OpenCode Zen models' },
  'opencode-go': { provider: 'opencode-go', means: 'the OpenCode Console Go plan' },
  go: { provider: 'opencode-go', means: 'the OpenCode Console Go plan' },
  ollama: { provider: 'ollama-cloud', means: 'the Ollama Cloud models' },
  'ollama-cloud': { provider: 'ollama-cloud', means: 'the Ollama Cloud models' },
  'ollama-local': { provider: 'ollama', means: 'the Ollama models on this machine' },
};

/** The provider an alias names, or nothing when the name is not one. */
export function resolveProviderAlias(name: string): ProviderId | undefined {
  return PROVIDER_ALIASES[name.toLowerCase()]?.provider;
}

/** The aliases and what each one means, for the error message. */
export function providerAliasSummary(): string {
  return Object.entries(PROVIDER_ALIASES)
    .map(([alias, entry]) => `${alias} = ${entry.means}`)
    .join(', ');
}

/**
 * The provider ids a lock records, the ones that still exist.
 *
 * The lock holds ids and not names, so they are read as ids. Reading them
 * as names would send a lock that names the local provider to the cloud one.
 */
export function providerIdsFromLock(lock: ModelLock | undefined): ProviderId[] {
  const ids: ProviderId[] = [];
  for (const id of lock?.providers ?? []) {
    if (PROVIDER_IDS.includes(id as ProviderId)) ids.push(id as ProviderId);
  }
  return ids;
}

export type SelectModelsInput = {
  root: string;
  roles: RolesFile;
  providers: ProviderSelection[];
  /** Take the flash variant of the family a role would get, when it qualifies. */
  preferFlash?: boolean;
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

  // The provider names come from a file a person wrote, and one of them
  // becomes a key in the inventory. A name like __proto__ would change the
  // prototype of that inventory instead of adding an entry, so the name is
  // checked against the providers that exist.
  for (const selection of input.providers) {
    if (!PROVIDER_IDS.includes(selection.provider)) {
      throw new Error(
        `unknown provider: ${selection.provider}. The provider ids are ${PROVIDER_IDS.join(', ')}. ` +
          `The names you may use: ${providerAliasSummary()}.`,
      );
    }
  }

  const served: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
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

  const assembled = assembleCandidates({
    providers: input.providers,
    served,
    modelsDev: modelsDev.catalog,
    benchLmIndex: buildSurfaceIndex(benchLm.catalog),
    aliases: aliasFile.aliases,
    policy,
  });

  // The flash preference rides with the candidate set, because the lock
  // builder takes no preference of its own and every role applies this one.
  const candidates = input.preferFlash === true ? withFlashPreference(assembled) : assembled;

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
