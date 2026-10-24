import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeCatalogCache } from './cache.js';
import type { FetchLike } from './providers.js';
import type { EvidenceLabel, RankEntry, Surface } from './types.js';

export type BenchLmItem = {
  rank: number;
  slug: string;
  canonicalModelKey: string;
  model: string;
  creator: string;
  displayScore: number;
  evidenceStatus: EvidenceLabel;
  scoreConfidence: number;
  overallRank: number;
  rankingEligible: boolean;
};

export type BenchLmCatalog = {
  generatedAt: string;
  items: BenchLmItem[];
  categories: Record<string, BenchLmItem[]>;
};

export const BENCHLM_KEYLESS_URL = 'https://benchlm.ai/data/leaderboard.json';
export const BENCHLM_REST_BASE = 'https://data.benchlm.ai/v1';
export const BENCHLM_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Strip the punctuation so two spellings of one model meet. */
export function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function benchLmCachePath(root: string): string {
  return join(root, '.openagentsy', 'cache', 'benchlm.json');
}

export async function fetchBenchLm(
  fetchImpl: FetchLike = fetch,
  key?: string,
): Promise<BenchLmCatalog> {
  const headers: Record<string, string> = {};
  if (key) headers.Authorization = `Bearer ${key}`;

  const response = await fetchImpl(BENCHLM_KEYLESS_URL, { headers });
  if (!response.ok) {
    throw new Error(`benchlm returned ${response.status}`);
  }
  const payload = (await response.json()) as {
    generatedAt: string;
    items: BenchLmItem[];
    categories: Record<string, BenchLmItem[]>;
  };
  return {
    generatedAt: payload.generatedAt,
    items: payload.items ?? [],
    categories: payload.categories ?? {},
  };
}

export type CachedBenchLm = {
  fetchedAt: string;
  catalog: BenchLmCatalog;
};

export async function loadBenchLm(
  root: string,
  options: { fetchImpl?: FetchLike; now?: number; key?: string } = {},
): Promise<{ catalog: BenchLmCatalog; source: 'cache' | 'network'; fetchedAt: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now();
  const path = benchLmCachePath(root);

  try {
    const cached = JSON.parse(await readFile(path, 'utf8')) as CachedBenchLm;
    if (now - Date.parse(cached.fetchedAt) < BENCHLM_CACHE_TTL_MS) {
      return { catalog: cached.catalog, source: 'cache', fetchedAt: cached.fetchedAt };
    }
  } catch {
    // No cache, or the cache is unreadable. Fetch it.
  }

  const catalog = await fetchBenchLm(fetchImpl, options.key);
  const fetchedAt = await writeCatalogCache(path, catalog, now);
  return { catalog, source: 'network', fetchedAt };
}

export type SurfaceEntry = {
  rank: number;
  score: number;
  evidence: EvidenceLabel;
  scoreConfidence: number;
  creator: string;
};

/** One index per surface, keyed by every spelling of the model. */
export function buildSurfaceIndex(
  catalog: BenchLmCatalog,
): Map<Surface, Map<string, SurfaceEntry>> {
  const surfaces = new Map<Surface, Map<string, SurfaceEntry>>();

  const add = (surface: Surface, items: BenchLmItem[]) => {
    const index = surfaces.get(surface) ?? new Map<string, SurfaceEntry>();
    for (const item of items) {
      if (!item.rankingEligible) continue;
      const entry: SurfaceEntry = {
        rank: item.rank,
        score: item.displayScore,
        evidence: item.evidenceStatus,
        scoreConfidence: item.scoreConfidence,
        creator: item.creator,
      };
      for (const key of [item.slug, item.canonicalModelKey, item.model]) {
        if (!index.has(normalizeKey(key))) index.set(normalizeKey(key), entry);
      }
    }
    surfaces.set(surface, index);
  };

  add('overall', catalog.items);
  for (const [name, items] of Object.entries(catalog.categories)) {
    if (name === 'agentic' || name === 'coding') {
      add(name, items);
    }
  }

  return surfaces;
}

/**
 * Look up the ranks of one provider model.
 *
 * The order is deliberate: an alias that was confirmed by hand wins, then the
 * canonical id, then the model id, then the display name. A model that cannot
 * be found stays unranked rather than being matched loosely.
 */
export function ranksFor(
  index: Map<Surface, Map<string, SurfaceEntry>>,
  candidates: { canonicalId?: string; id: string; name: string },
  alias?: string,
): Partial<Record<Surface, RankEntry>> {
  const keys: string[] = [];
  if (alias) keys.push(normalizeKey(alias));
  if (candidates.canonicalId) {
    const stripped = candidates.canonicalId.split('/').pop();
    if (stripped) keys.push(normalizeKey(stripped));
  }
  keys.push(normalizeKey(candidates.id));
  keys.push(normalizeKey(candidates.name));

  const out: Partial<Record<Surface, RankEntry>> = {};
  for (const [surface, surfaceIndex] of index) {
    for (const key of keys) {
      const entry = surfaceIndex.get(key);
      if (entry) {
        out[surface] = { surface, ...entry };
        break;
      }
    }
  }
  return out;
}
