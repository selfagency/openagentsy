import { describe, expect, it } from 'vitest';
import {
  normalizeModelId,
  providerDefaults,
  type Registry,
  resolveArch,
  resolveSite,
} from './resolve.js';
import { type ModelArch, r } from './types.js';

const ARCH: ModelArch = {
  totalParamsB: r(70),
  activeParamsB: r(70),
  source: 'user',
};

function registry(overrides: Partial<Registry> = {}): Registry {
  return {
    ecologitsModels: new Map(),
    overrides: new Map(),
    providerSites: new Map(),
    grid: new Map(),
    offsiteWue: new Map(),
    ...overrides,
  };
}

describe('the provider table', () => {
  it('keeps the numbers the methodology publishes', () => {
    expect(providerDefaults('anthropic')).toMatchObject({
      pue: [1.09, 1.14],
      wueOnSite: [0.13, 0.999],
      disclosed: true,
    });
    expect(providerDefaults('google')).toMatchObject({
      pue: [1.09, 1.09],
      wueOnSite: [0.999, 0.999],
    });
    expect(providerDefaults('mistral')).toMatchObject({
      pue: [1.16, 1.16],
      wueOnSite: [0.09, 0.09],
    });
    expect(providerDefaults('openai')).toMatchObject({
      pue: [1.2, 1.2],
      wueOnSite: [0.569, 0.569],
    });
  });

  it('knows the names the methodology uses', () => {
    expect(providerDefaults('google_genai')).toEqual(providerDefaults('google'));
    expect(providerDefaults('mistralai')).toEqual(providerDefaults('mistral'));
  });

  it('gives an unknown provider the widest range, marked as undisclosed', () => {
    const unknown = providerDefaults('ollama-cloud');
    expect(unknown.pue).toEqual([1.09, 1.14]);
    expect(unknown.wueOnSite).toEqual([0.13, 0.999]);
    expect(unknown.disclosed).toBe(false);
  });
});

describe('the model id', () => {
  it('drops the provider and the case', () => {
    expect(normalizeModelId('Ollama/Qwen3:8B')).toBe('qwen3:8b');
    expect(normalizeModelId('  gpt-4o-mini ')).toBe('gpt-4o-mini');
  });
});

describe('the architecture of a model', () => {
  it('prefers the number the user wrote for that provider', () => {
    const reg = registry({
      overrides: new Map([
        ['openai/gpt-4o-mini', ARCH],
        ['gpt-4o-mini', { ...ARCH, totalParamsB: r(1) }],
      ]),
    });
    expect(resolveArch(reg, 'openai', 'gpt-4o-mini')).toEqual(ARCH);
  });

  it('falls back to the number the user wrote for any provider', () => {
    const reg = registry({ overrides: new Map([['gpt-4o-mini', ARCH]]) });
    expect(resolveArch(reg, 'azure', 'gpt-4o-mini')).toEqual(ARCH);
  });

  it('then takes the model map, under the normalised name', () => {
    const reg = registry({ ecologitsModels: new Map([['gpt-4o-mini', ARCH]]) });
    expect(resolveArch(reg, 'openai', 'GPT-4o-Mini')).toEqual(ARCH);
  });

  it('and says the model size is unknown when nobody knows it', () => {
    const unknown = resolveArch(registry(), 'openai', 'mystery-model');
    expect(unknown.source).toBe('unknown');
    expect(unknown.totalParamsB[0]).toBe(10);
    expect(unknown.totalParamsB[1]).toBe(2000);
  });
});

describe('the site of a provider', () => {
  it('joins the provider numbers with the grid numbers', () => {
    const reg = registry({
      grid: new Map([['US', r(0.4)]]),
      offsiteWue: new Map([['US', r(1.6)]]),
    });
    const site = resolveSite(reg, 'openai', 'US');
    expect(site.pue).toEqual([1.2, 1.2]);
    expect(site.wueOnSite).toEqual([0.569, 0.569]);
    expect(site.gridKgCo2PerKWh).toEqual([0.4, 0.4]);
    expect(site.wueOffSite).toEqual([1.6, 1.6]);
  });

  it('falls back to the world when the region is unknown', () => {
    const reg = registry({
      grid: new Map([['WORLD', r(0.5)]]),
      offsiteWue: new Map([['WORLD', r(2)]]),
    });
    const site = resolveSite(reg, 'openai', 'FR');
    expect(site.gridKgCo2PerKWh).toEqual([0.5, 0.5]);
    expect(site.wueOffSite).toEqual([2, 2]);
  });

  it('says what is missing instead of guessing a grid', () => {
    expect(() => resolveSite(registry(), 'openai', 'US')).toThrow(/grid carbon factor/);
  });
});
