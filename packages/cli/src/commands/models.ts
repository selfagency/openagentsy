import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { loadRoles } from '@openagentsy/core';
import {
  type FetchLike,
  LOCK_FILE_NAME,
  type ModelLock,
  type ProviderId,
  type ProviderSelection,
  providerAliasSummary,
  providerIdsFromLock,
  readLock,
  resolveProviderAlias,
  selectModels,
  writeLock,
} from '@openagentsy/models';

export type ModelsMode = 'init' | 'refresh' | 'switch';

export type ModelsOptions = {
  root: string;
  mode: ModelsMode;
  providers: string[];
  /** Take the flash variant of the family a role would get, when it qualifies. */
  preferFlash?: boolean;
  allowTraining?: boolean;
  allowRetention?: boolean;
  yes?: boolean;
  key?: string;
  fetchImpl?: FetchLike;
};

export type ModelsResult = {
  lock: ModelLock;
  reasons: Record<string, string>;
  rejected: Record<string, { openCodeId: string; reason: string }[]>;
  failures: Record<string, string>;
  written: boolean;
  path: string;
  changes: { role: string; from?: string; to: string; note: string }[];
  mode: ModelsMode;
  providers: ProviderId[];
  /** What a switch touches besides the lock. */
  touches?: SwitchTouches;
};

/** What a switch touches besides the lock file. */
export type SwitchTouches = {
  /** The command that regenerates the agent files. */
  rebuild: string;
  /** The providers the lock names now. */
  providers: ProviderId[];
  /** The environment variables the providers read their key from. */
  keys: string[];
};

/** The provider a command runs with when nothing else is asked for. */
const DEFAULT_PROVIDERS = ['opencode-go'];

/** The environment variable each provider reads its key from. */
const PROVIDER_KEYS: Record<ProviderId, string | undefined> = {
  opencode: 'OPENCODE_API_KEY',
  'opencode-go': 'OPENCODE_API_KEY',
  'ollama-cloud': 'OLLAMA_API_KEY',
  ollama: undefined,
};

/** The provider names a person may type, resolved to the provider ids. */
function parseProviders(input: string[]): ProviderSelection[] {
  const seen = new Set<string>();
  const selections: ProviderSelection[] = [];
  for (const raw of input) {
    for (const part of raw.split(',')) {
      const name = part.trim().toLowerCase();
      if (name.length === 0) continue;
      const provider = resolveProviderAlias(name);
      if (!provider) {
        throw new Error(
          `unknown provider "${name}". The names you may use: ${providerAliasSummary()}.`,
        );
      }
      if (seen.has(provider)) continue;
      seen.add(provider);
      selections.push({ provider });
    }
  }
  return selections;
}

/**
 * The providers a command runs with.
 *
 * A refresh uses the providers the lock records, so a refresh cannot move
 * the project back to a provider the lock no longer names. A lock that names
 * no provider yet falls back to the default.
 */
function resolveProviders(
  mode: ModelsMode,
  requested: string[],
  previous: ModelLock | undefined,
): ProviderSelection[] {
  const parsed = parseProviders(requested);
  if (parsed.length > 0) return parsed;

  if (mode === 'switch') {
    throw new Error('switch needs a provider: openagentsy models switch ollama-cloud');
  }

  if (mode === 'refresh') {
    const fromLock = providerIdsFromLock(previous);
    if (fromLock.length > 0) return fromLock.map((provider) => ({ provider }));
  }

  return parseProviders(DEFAULT_PROVIDERS);
}

async function confirm(question: string, yes: boolean | undefined): Promise<boolean> {
  if (yes === true) return true;
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return answer.trim().toLowerCase() === 'y';
  } finally {
    rl.close();
  }
}

/** What the switch touches besides the lock. */
function touchesFor(providers: ProviderId[]): SwitchTouches {
  const keys: string[] = [];
  for (const provider of providers) {
    const key = PROVIDER_KEYS[provider];
    if (key !== undefined && !keys.includes(key)) keys.push(key);
  }
  return { rebuild: 'openagentsy build', providers, keys };
}

export async function runModels(options: ModelsOptions): Promise<ModelsResult> {
  const path = join(options.root, LOCK_FILE_NAME);
  const roles = await loadRoles(join(options.root, 'roles.yaml'));
  const previous = await readLock(path);
  const providers = resolveProviders(options.mode, options.providers, previous);

  const result = await selectModels({
    root: options.root,
    roles,
    providers,
    ...(options.preferFlash !== undefined ? { preferFlash: options.preferFlash } : {}),
    ...(options.allowTraining !== undefined ? { allowTraining: options.allowTraining } : {}),
    ...(options.allowRetention !== undefined ? { allowRetention: options.allowRetention } : {}),
    ...(options.key !== undefined ? { benchLmKey: options.key } : {}),
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  });

  const changes: ModelsResult['changes'] = [];
  for (const [role, entry] of Object.entries(result.lock.roles)) {
    const from = previous?.roles[role]?.model;
    changes.push({
      role,
      ...(from !== undefined ? { from } : {}),
      to: entry.model,
      note: result.reasons[role] ?? '',
    });
  }

  const approved =
    Object.keys(result.failures).length === 0
      ? await confirm(
          `Write ${LOCK_FILE_NAME} with these ${changes.length} role assignments?`,
          options.yes,
        )
      : false;

  if (approved) {
    await writeLock(path, result.lock);
  }

  const providerIds = providers.map((selection) => selection.provider);

  return {
    lock: result.lock,
    reasons: result.reasons,
    rejected: result.rejected,
    failures: result.failures,
    written: approved,
    path,
    changes,
    mode: options.mode,
    providers: providerIds,
    ...(options.mode === 'switch' ? { touches: touchesFor(providerIds) } : {}),
  };
}
