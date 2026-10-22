import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Write a fetched catalog to the cache.
 *
 * Both catalogs are cached the same way: the file holds the fetch time next
 * to the payload, so a stale cache can be spotted without a second field.
 */
export async function writeCatalogCache<T>(path: string, catalog: T, now: number): Promise<string> {
  const fetchedAt = new Date(now).toISOString();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ fetchedAt, catalog }), 'utf8');
  return fetchedAt;
}
