#!/usr/bin/env node
/**
 * Refresh the bundled pricing snapshot.
 *
 * The runtime prices a message from the network, and falls back to the files
 * this script writes when the network is not there. Run it when the prices
 * have gone stale:
 *
 *   bun packages/ledger/scripts/fetch-pricing.mjs
 *
 * The three sources are the ones of the pricing chain (§6.3): models.dev,
 * LiteLLM and OpenRouter. Each file holds the reduced shape the runtime
 * reads, so the snapshot stays small enough to commit.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'data', 'pricing');

function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

function readString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The rates of a model, or nothing when it has none.
 *
 * A model nobody prices is not in the snapshot: a rate of zero for a real
 * model would price a million tokens at nothing, which is a lie about money.
 */
function ratesOf(input, output, cacheRead, cacheWrite) {
  if (input === 0 && output === 0) return undefined;
  return {
    input,
    output,
    ...(cacheRead > 0 ? { cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWrite } : {}),
  };
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  return response.json();
}

function reduceModelsDev(raw) {
  const out = {};
  for (const [providerId, provider] of Object.entries(record(raw))) {
    const models = {};
    for (const [modelId, model] of Object.entries(record(record(provider).models))) {
      const cost = record(record(model).cost);
      const found = ratesOf(
        num(cost.input),
        num(cost.output),
        num(cost.cache_read),
        num(cost.cache_write),
      );
      if (found !== undefined) models[modelId] = found;
    }
    if (Object.keys(models).length > 0) out[providerId] = models;
  }
  return out;
}

function liteLlmBands(entry) {
  const bands = [];
  for (const [key, value] of Object.entries(entry)) {
    const match = /^input_cost_per_token_above_(\d+)(k?)_tokens$/.exec(key);
    if (match === null) continue;
    const rate = num(value);
    if (rate === 0) continue;
    const count = Number(match[1]);
    const output = num(entry[key.replace('input_cost_per_token', 'output_cost_per_token')]);
    const cacheRead = num(
      entry[key.replace('input_cost_per_token', 'cache_read_input_token_cost')],
    );
    const cacheWrite = num(
      entry[key.replace('input_cost_per_token', 'cache_creation_input_token_cost')],
    );
    bands.push({
      above: match[2] === 'k' ? count * 1000 : count,
      input: rate * 1_000_000,
      output: output * 1_000_000,
      ...(cacheRead > 0 ? { cacheRead: cacheRead * 1_000_000 } : {}),
      ...(cacheWrite > 0 ? { cacheWrite: cacheWrite * 1_000_000 } : {}),
    });
  }
  return bands.sort((a, b) => a.above - b.above);
}

function reduceLiteLLM(raw) {
  const out = {};
  for (const [key, entry] of Object.entries(record(raw))) {
    const model = record(entry);
    const found = ratesOf(
      num(model.input_cost_per_token) * 1_000_000,
      num(model.output_cost_per_token) * 1_000_000,
      num(model.cache_read_input_token_cost) * 1_000_000,
      num(model.cache_creation_input_token_cost) * 1_000_000,
    );
    if (found === undefined) continue;
    const bands = liteLlmBands(model);
    out[key] = bands.length > 0 ? { ...found, tiers: bands } : found;
  }
  return out;
}

function reduceOpenRouter(raw) {
  const out = {};
  const data = record(raw).data;
  if (!Array.isArray(data)) return out;
  for (const model of data) {
    const entry = record(model);
    const id = readString(entry.id);
    if (id === undefined) continue;
    const pricing = record(entry.pricing);
    const found = ratesOf(
      num(pricing.prompt) * 1_000_000,
      num(pricing.completion) * 1_000_000,
      num(pricing.input_cache_read) * 1_000_000,
      num(pricing.input_cache_write) * 1_000_000,
    );
    if (found !== undefined) out[id] = found;
  }
  return out;
}

const SOURCES = [
  {
    file: 'models.dev',
    url: 'https://models.dev/api.json',
    reduce: reduceModelsDev,
  },
  {
    file: 'litellm',
    url: 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json',
    reduce: reduceLiteLLM,
  },
  {
    file: 'openrouter',
    url: 'https://openrouter.ai/api/v1/models',
    reduce: reduceOpenRouter,
  },
];

mkdirSync(outDir, { recursive: true });

for (const source of SOURCES) {
  const payload = source.reduce(await getJson(source.url));
  const path = join(outDir, `${source.file}.json`);
  writeFileSync(path, `${JSON.stringify(payload)}\n`, 'utf8');
  const size = JSON.stringify(payload).length;
  process.stdout.write(`${source.file}: ${Object.keys(payload).length} entries, ${size} bytes\n`);
}
