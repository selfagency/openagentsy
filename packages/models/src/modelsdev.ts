import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeCatalogCache } from './cache.js';
import type { FetchLike } from './providers.js';

export type ModelsDevModel = {
  id: string;
  name: string;
  tool_call?: boolean;
  reasoning?: boolean;
  reasoning_options?: { type: string; values: string[] }[];
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number; cache_read?: number };
  canonical_model_id?: string;
  release_date?: string;
  attachment?: boolean;
  modalities?: { input?: string[]; output?: string[] };
};

export type ModelsDevProvider = {
  id: string;
  models: Record<string, ModelsDevModel>;
};

export type ModelsDevCatalog = Record<string, ModelsDevProvider>;

export const MODELS_DEV_URL = 'https://models.dev/api.json';

export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type CachedCatalog = {
  fetchedAt: string;
  catalog: ModelsDevCatalog;
};

export function cachePath(root: string): string {
  return join(root, '.openagentsy', 'cache', 'models-dev.json');
}

export async function fetchModelsDev(fetchImpl: FetchLike = fetch): Promise<ModelsDevCatalog> {
  const response = await fetchImpl(MODELS_DEV_URL);
  if (!response.ok) {
    throw new Error(`models.dev returned ${response.status}`);
  }
  return (await response.json()) as ModelsDevCatalog;
}

export type LoadResult = {
  catalog: ModelsDevCatalog;
  source: 'cache' | 'network';
  fetchedAt: string;
};

/**
 * Load the models.dev catalog, using the local cache when it is younger than
 * a week. The catalog is over five megabytes, so fetching it on every
 * selection would be wasteful.
 */
export async function loadModelsDev(
  root: string,
  options: { fetchImpl?: FetchLike; now?: number } = {},
): Promise<LoadResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now();
  const path = cachePath(root);

  try {
    const cached = JSON.parse(await readFile(path, 'utf8')) as CachedCatalog;
    if (now - Date.parse(cached.fetchedAt) < CACHE_TTL_MS) {
      return { catalog: cached.catalog, source: 'cache', fetchedAt: cached.fetchedAt };
    }
  } catch {
    // No cache, or the cache is unreadable. Fetch it.
  }

  const catalog = await fetchModelsDev(fetchImpl);
  const fetchedAt = await writeCatalogCache(path, catalog, now);
  return { catalog, source: 'network', fetchedAt };
}
