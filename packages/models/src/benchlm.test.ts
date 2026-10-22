import { describe, expect, it } from 'vitest';
import { type BenchLmCatalog, buildSurfaceIndex, normalizeKey, ranksFor } from './benchlm.js';

const CATALOG: BenchLmCatalog = {
  generatedAt: '2026-10-22T00:00:00Z',
  items: [
    {
      rank: 1,
      slug: 'claude-opus-5-5',
      canonicalModelKey: 'claude-opus-5-5',
      model: 'Claude Opus 5.5',
      creator: 'Anthropic',
      displayScore: 86.69,
      evidenceStatus: 'supported',
      scoreConfidence: 4,
      overallRank: 1,
      rankingEligible: true,
    },
    {
      rank: 17,
      slug: 'kimi-k3',
      canonicalModelKey: 'kimi-3',
      model: 'Kimi K3',
      creator: 'Moonshot AI',
      displayScore: 69.93,
      evidenceStatus: 'supported',
      scoreConfidence: 3,
      overallRank: 17,
      rankingEligible: true,
    },
  ],
  categories: {
    agentic: [
      {
        rank: 8,
        slug: 'glm-5-3',
        canonicalModelKey: 'glm-5-3',
        model: 'GLM 5.3',
        creator: 'Zhipu',
        displayScore: 67.94,
        evidenceStatus: 'supported',
        scoreConfidence: 3,
        overallRank: 20,
        rankingEligible: true,
      },
    ],
    coding: [
      {
        rank: 18,
        slug: 'deepseek-v4-1-flash',
        canonicalModelKey: 'deepseek-v4-1-flash',
        model: 'DeepSeek V4.1 Flash',
        creator: 'DeepSeek',
        displayScore: 65.65,
        evidenceStatus: 'supported',
        scoreConfidence: 3,
        overallRank: 35,
        rankingEligible: true,
      },
    ],
  },
};

describe('normalizeKey', () => {
  it('drops the punctuation so two spellings meet', () => {
    expect(normalizeKey('deepseek-v4.1-flash')).toBe('deepseekv41flash');
    expect(normalizeKey('deepseek-v4-1-flash')).toBe('deepseekv41flash');
  });
});

describe('buildSurfaceIndex', () => {
  it('indexes every surface', () => {
    const index = buildSurfaceIndex(CATALOG);
    expect([...index.keys()].sort()).toEqual(['agentic', 'coding', 'overall']);
  });

  it('indexes a model under its slug and its canonical key', () => {
    const index = buildSurfaceIndex(CATALOG);
    const overall = index.get('overall');
    if (!overall) throw new Error('no overall surface');
    expect(overall.get('kimik3')?.rank).toBe(17);
    expect(overall.get('kimi3')?.rank).toBe(17);
  });

  it('skips a model that is not eligible for the ranking', () => {
    const catalog: BenchLmCatalog = {
      ...CATALOG,
      items: CATALOG.items.map((item) => ({ ...item, rankingEligible: false })),
    };
    const index = buildSurfaceIndex(catalog);
    expect(index.get('overall')?.size).toBe(0);
  });
});

describe('ranksFor', () => {
  const index = buildSurfaceIndex(CATALOG);

  it('matches on the canonical id with the lab prefix removed', () => {
    const ranks = ranksFor(index, {
      canonicalId: 'moonshotai/kimi-k3',
      id: 'kimi-k3',
      name: 'Kimi K3',
    });
    expect(ranks.overall?.rank).toBe(17);
  });

  it('matches on the model id when the canonical id is missing', () => {
    const ranks = ranksFor(index, { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' });
    expect(ranks.coding?.rank).toBe(18);
  });

  it('prefers a confirmed alias over a loose match', () => {
    const ranks = ranksFor(
      index,
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      'deepseek-v4-1-flash',
    );
    expect(ranks.coding?.rank).toBe(18);
  });

  it('leaves a model that is not in the catalog unranked', () => {
    const ranks = ranksFor(index, { id: 'longcat-2.0', name: 'LongCat 2.0' });
    expect(ranks.overall).toBeUndefined();
    expect(ranks.coding).toBeUndefined();
  });
});
