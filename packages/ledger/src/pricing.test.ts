import { readFileSync, utimesSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultSnapshotDir, type FetchLike, priceMessage } from './pricing.js';

let root: string;
let cacheDir: string;
let snapshotDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openagentsy-pricing-'));
  cacheDir = join(root, 'cache');
  snapshotDir = join(root, 'snapshot');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const MODELS_DEV = {
  anthropic: {
    models: {
      'shared-x': { cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } },
    },
  },
};

const LITELLM = {
  'shared-x': {
    input_cost_per_token: 0.000001,
    output_cost_per_token: 0.000002,
  },
};

const OPENROUTER = {
  data: [
    {
      id: 'anthropic/shared-x',
      pricing: { prompt: '0.0000005', completion: '0.000001' },
    },
  ],
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** A fetch that answers per source and 404s the rest. */
function routing(sources: Record<string, unknown>): FetchLike {
  return async (input) => {
    const url = String(input);
    if (url.includes('models.dev')) {
      return sources.modelsDev === undefined
        ? new Response('not found', { status: 404 })
        : jsonResponse(sources.modelsDev);
    }
    if (url.includes('litellm')) {
      return sources.litellm === undefined
        ? new Response('not found', { status: 404 })
        : jsonResponse(sources.litellm);
    }
    if (url.includes('openrouter')) {
      return sources.openrouter === undefined
        ? new Response('not found', { status: 404 })
        : jsonResponse(sources.openrouter);
    }
    return new Response('not found', { status: 404 });
  };
}

const OFFLINE: FetchLike = async () => {
  throw new Error('offline');
};

const TOKENS = { input: 1000, output: 100 };

describe('the pricing chain', () => {
  it('takes the cost the host reported first', async () => {
    const result = await priceMessage('anthropic', 'shared-x', TOKENS, {
      reportedCost: 0.5,
      cacheDir,
      snapshotDir,
      fetchImpl: OFFLINE,
    });
    expect(result.cost).toBe(0.5);
    expect(result.source).toBe('reported');
  });

  it('prefers models.dev over the other sources', async () => {
    const result = await priceMessage('anthropic', 'shared-x', TOKENS, {
      cacheDir,
      snapshotDir,
      fetchImpl: routing({ modelsDev: MODELS_DEV, litellm: LITELLM, openrouter: OPENROUTER }),
    });
    expect(result.source).toBe('models.dev');
    expect(result.cost).toBeCloseTo((1000 * 3) / 1_000_000 + (100 * 15) / 1_000_000, 10);
  });

  it('falls through to LiteLLM', async () => {
    const result = await priceMessage('anthropic', 'shared-x', TOKENS, {
      cacheDir,
      snapshotDir,
      fetchImpl: routing({ litellm: LITELLM, openrouter: OPENROUTER }),
    });
    expect(result.source).toBe('litellm');
    expect(result.cost).toBeCloseTo(1000 / 1_000_000 + 200 / 1_000_000, 10);
  });

  it('falls through to OpenRouter', async () => {
    const result = await priceMessage('anthropic', 'shared-x', TOKENS, {
      cacheDir,
      snapshotDir,
      fetchImpl: routing({ openrouter: OPENROUTER }),
    });
    expect(result.source).toBe('openrouter');
    expect(result.cost).toBeCloseTo((1000 * 0.5) / 1_000_000 + 100 / 1_000_000, 10);
  });

  it('leaves an unpriced model empty, never at zero', async () => {
    const result = await priceMessage('anthropic', 'shared-x', TOKENS, {
      cacheDir,
      snapshotDir,
      fetchImpl: routing({}),
    });
    expect(result.cost).toBe(null);
    expect(result.cost).not.toBe(0);
    expect(result.source).toBe('none');
  });

  it('respects the bands of a source', async () => {
    const banded = {
      'shared-x': {
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000002,
        input_cost_per_token_above_128k_tokens: 0.000003,
        output_cost_per_token_above_128k_tokens: 0.000004,
      },
    };
    const options = { cacheDir, snapshotDir, fetchImpl: routing({ litellm: banded }) };

    const small = await priceMessage(
      'anthropic',
      'shared-x',
      { input: 1000, output: 1000 },
      options,
    );
    expect(small.cost).toBeCloseTo(1000 / 1_000_000 + 2000 / 1_000_000, 10);

    const large = await priceMessage(
      'anthropic',
      'shared-x',
      { input: 200 * 1000, output: 1000 },
      options,
    );
    expect(large.cost).toBeCloseTo((200 * 1000 * 3) / 1_000_000 + (1000 * 4) / 1_000_000, 10);
  });
});

describe('the pricing cache', () => {
  it('keeps a source for a day and fetches it again after that', async () => {
    let calls = 0;
    const counting: FetchLike = async () => {
      calls += 1;
      return jsonResponse(MODELS_DEV);
    };
    const options = { cacheDir, snapshotDir, fetchImpl: counting };

    await priceMessage('anthropic', 'shared-x', TOKENS, options);
    expect(calls).toBe(1);

    await priceMessage('anthropic', 'shared-x', TOKENS, options);
    expect(calls).toBe(1);

    const file = join(cacheDir, 'models.dev.json');
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    utimesSync(file, old, old);

    await priceMessage('anthropic', 'shared-x', TOKENS, options);
    expect(calls).toBe(2);
  });

  it('falls back to the bundled snapshot when the network is not there', async () => {
    const bundled = JSON.parse(
      readFileSync(join(defaultSnapshotDir(), 'models.dev.json'), 'utf8'),
    ) as Record<string, Record<string, { input: number; output: number }>>;
    const provider = Object.keys(bundled).sort()[0] ?? '';
    const model = Object.keys(bundled[provider] ?? {}).sort()[0] ?? '';
    expect(provider).not.toBe('');
    expect(model).not.toBe('');

    const result = await priceMessage(provider, model, TOKENS, {
      cacheDir,
      fetchImpl: OFFLINE,
    });
    expect(result.source).toBe('models.dev');
    expect(result.cost).toBeGreaterThan(0);
  });
});
