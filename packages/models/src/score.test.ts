import type { ModelProfile } from '@openagentsy/core';
import { describe, expect, it } from 'vitest';
import { selectModel } from './score.js';
import type { Candidate, ProviderModel, RankEntry, Retention } from './types.js';

const SAFE_RETENTION: Retention = {
  trainsOnPrompts: false,
  zeroDataRetention: true,
  retentionDays: 0,
  source: 'test',
  checkedAt: '2026-10-22',
};

function model(overrides: Partial<ProviderModel> = {}): ProviderModel {
  return {
    provider: 'opencode-go',
    id: 'model-a',
    openCodeId: 'opencode-go/model-a',
    name: 'Model A',
    tools: true,
    thinking: true,
    vision: false,
    reasoning: true,
    variants: ['low', 'medium', 'high', 'xhigh', 'max'],
    contextWindow: 500_000,
    creator: 'Creator A',
    ...overrides,
  };
}

function rank(
  surface: 'overall' | 'agentic' | 'coding',
  value: number,
  evidence: 'supported' | 'estimated' = 'supported',
): RankEntry {
  return {
    surface,
    rank: value,
    score: 100 - value,
    evidence,
    scoreConfidence: 3,
    creator: 'Creator A',
  };
}

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    model: model(),
    ranks: { coding: rank('coding', 5), agentic: rank('agentic', 5), overall: rank('overall', 5) },
    retention: SAFE_RETENTION,
    ...overrides,
  };
}

const PROFILE: ModelProfile = {
  primarySignal: 'coding',
  hardRequirements: ['tool_calls'],
  costStance: 'quality_first',
};

describe('selectModel', () => {
  it('picks the best ranked model when quality comes first', () => {
    const result = selectModel({
      profile: PROFILE,
      candidates: [
        candidate({
          model: model({ openCodeId: 'a', id: 'a' }),
          ranks: { coding: rank('coding', 9) },
        }),
        candidate({
          model: model({ openCodeId: 'b', id: 'b' }),
          ranks: { coding: rank('coding', 3) },
        }),
      ],
    });
    expect(result.model.openCodeId).toBe('b');
    expect(result.evidence.rank).toBe(3);
  });

  it('rejects a model that cannot call tools', () => {
    const result = selectModel({
      profile: PROFILE,
      candidates: [
        candidate({
          model: model({ openCodeId: 'no-tools', tools: false }),
          ranks: { coding: rank('coding', 1) },
        }),
        candidate({ model: model({ openCodeId: 'ok' }), ranks: { coding: rank('coding', 20) } }),
      ],
    });
    expect(result.model.openCodeId).toBe('ok');
    expect(result.rejected[0]).toEqual({ openCodeId: 'no-tools', reason: 'no tool calling' });
  });

  it('rejects a model whose terms train on prompts', () => {
    const result = selectModel({
      profile: PROFILE,
      candidates: [
        candidate({
          model: model({ openCodeId: 'trains' }),
          ranks: { coding: rank('coding', 1) },
          retention: { ...SAFE_RETENTION, trainsOnPrompts: true, zeroDataRetention: false },
        }),
        candidate({ model: model({ openCodeId: 'safe' }), ranks: { coding: rank('coding', 9) } }),
      ],
    });
    expect(result.model.openCodeId).toBe('safe');
    expect(result.rejected[0]?.reason).toBe('trains on prompts');
  });

  it('rejects a model that is not zero data retention', () => {
    const result = selectModel({
      profile: PROFILE,
      candidates: [
        candidate({
          model: model({ openCodeId: 'retains' }),
          ranks: { coding: rank('coding', 1) },
          retention: { ...SAFE_RETENTION, zeroDataRetention: false, retentionDays: 30 },
        }),
        candidate({ model: model({ openCodeId: 'safe' }), ranks: { coding: rank('coding', 9) } }),
      ],
    });
    expect(result.model.openCodeId).toBe('safe');
    expect(result.rejected[0]?.reason).toBe('retains data for 30 days');
  });

  it('lets a model through when the user opts in', () => {
    const result = selectModel({
      profile: PROFILE,
      allowTraining: true,
      allowRetention: true,
      candidates: [
        candidate({
          model: model({ openCodeId: 'trains' }),
          ranks: { coding: rank('coding', 1) },
          retention: { ...SAFE_RETENTION, trainsOnPrompts: true, zeroDataRetention: false },
        }),
      ],
    });
    expect(result.model.openCodeId).toBe('trains');
  });

  it('rejects a model below the rank threshold', () => {
    const result = selectModel({
      profile: { ...PROFILE, minimumRank: 40 },
      candidates: [
        candidate({ model: model({ openCodeId: 'weak' }), ranks: { coding: rank('coding', 55) } }),
        candidate({
          model: model({ openCodeId: 'strong' }),
          ranks: { coding: rank('coding', 22) },
        }),
      ],
    });
    expect(result.model.openCodeId).toBe('strong');
    expect(result.rejected[0]?.reason).toBe('rank 55 is below the threshold');
  });

  it('rejects an unranked model when a rank threshold is set', () => {
    const result = selectModel({
      profile: { ...PROFILE, minimumRank: 40 },
      candidates: [
        candidate({ model: model({ openCodeId: 'unranked' }), ranks: {} }),
        candidate({
          model: model({ openCodeId: 'ranked' }),
          ranks: { coding: rank('coding', 10) },
        }),
      ],
    });
    expect(result.model.openCodeId).toBe('ranked');
    expect(result.rejected.map((entry) => entry.reason)).toContain('unranked');
  });

  it('picks the cheapest model when the role wants the cheapest', () => {
    const result = selectModel({
      profile: { ...PROFILE, costStance: 'cheapest' },
      candidates: [
        candidate({
          model: model({ openCodeId: 'pricey', cost: { input: 10, output: 30 } }),
          ranks: { coding: rank('coding', 2) },
        }),
        candidate({
          model: model({ openCodeId: 'cheap', cost: { input: 1, output: 2 } }),
          ranks: { coding: rank('coding', 30) },
        }),
      ],
    });
    expect(result.model.openCodeId).toBe('cheap');
  });

  it('trades a few ranks for a better price when the role is balanced', () => {
    const result = selectModel({
      profile: { ...PROFILE, costStance: 'balanced' },
      candidates: [
        candidate({
          model: model({ openCodeId: 'best', cost: { input: 10, output: 30 } }),
          ranks: { coding: rank('coding', 2) },
        }),
        candidate({
          model: model({ openCodeId: 'near', cost: { input: 1, output: 2 } }),
          ranks: { coding: rank('coding', 5) },
        }),
        candidate({
          model: model({ openCodeId: 'far', cost: { input: 0.1, output: 0.2 } }),
          ranks: { coding: rank('coding', 40) },
        }),
      ],
    });
    expect(result.model.openCodeId).toBe('near');
  });

  it('prefers supported evidence over estimated inside the margin', () => {
    const result = selectModel({
      profile: PROFILE,
      candidates: [
        candidate({
          model: model({ openCodeId: 'estimated' }),
          ranks: { coding: rank('coding', 10, 'estimated') },
        }),
        candidate({
          model: model({ openCodeId: 'supported' }),
          ranks: { coding: rank('coding', 12, 'supported') },
        }),
      ],
    });
    expect(result.model.openCodeId).toBe('supported');
  });

  it('keeps the estimated model when the supported one is too far away', () => {
    const result = selectModel({
      profile: PROFILE,
      candidates: [
        candidate({
          model: model({ openCodeId: 'estimated' }),
          ranks: { coding: rank('coding', 10, 'estimated') },
        }),
        candidate({
          model: model({ openCodeId: 'supported' }),
          ranks: { coding: rank('coding', 30, 'supported') },
        }),
      ],
    });
    expect(result.model.openCodeId).toBe('estimated');
  });

  it('excludes a creator so the reviewer is a different family', () => {
    const result = selectModel({
      profile: PROFILE,
      excludeCreators: ['Creator A'],
      candidates: [
        candidate({
          model: model({ openCodeId: 'same', creator: 'Creator A' }),
          ranks: { coding: rank('coding', 1) },
        }),
        candidate({
          model: model({ openCodeId: 'other', creator: 'Creator B' }),
          ranks: { coding: rank('coding', 9) },
        }),
      ],
    });
    expect(result.model.openCodeId).toBe('other');
    expect(result.rejected[0]?.reason).toBe('same creator as the builder');
  });

  it('rejects a model whose quota is too small for the role', () => {
    const result = selectModel({
      profile: { ...PROFILE, expectedCallsPer5h: 2000 },
      candidates: [
        candidate({
          model: model({ openCodeId: 'small-quota' }),
          ranks: { coding: rank('coding', 1) },
          quota: { requestsPer5h: 110, source: 'test' },
        }),
        candidate({
          model: model({ openCodeId: 'big-quota' }),
          ranks: { coding: rank('coding', 9) },
        }),
      ],
    });
    expect(result.model.openCodeId).toBe('big-quota');
    expect(result.rejected[0]?.reason).toContain('quota of 110 requests per 5 hours');
  });

  it('throws when nothing satisfies the profile', () => {
    expect(() =>
      selectModel({
        profile: PROFILE,
        candidates: [candidate({ model: model({ tools: false }) })],
      }),
    ).toThrow(/no model satisfies/);
  });

  it('puts the better ranked rejections first', () => {
    const result = selectModel({
      profile: PROFILE,
      candidates: [
        candidate({
          model: model({ openCodeId: 'rank-50', tools: false }),
          ranks: { coding: rank('coding', 50) },
        }),
        candidate({
          model: model({ openCodeId: 'rank-2', tools: false }),
          ranks: { coding: rank('coding', 2) },
        }),
        candidate({
          model: model({ openCodeId: 'chosen' }),
          ranks: { coding: rank('coding', 30) },
        }),
      ],
    });
    expect(result.rejected[0]?.openCodeId).toBe('rank-2');
  });
});

describe('the flash preference', () => {
  const GLM = model({ openCodeId: 'glm-5.3', id: 'glm-5.3' });
  const GLM_FLASH = model({ openCodeId: 'glm-5.3-flash', id: 'glm-5.3-flash' });

  it('takes the flash variant of the family the role would have got', () => {
    const result = selectModel({
      profile: PROFILE,
      preferFlash: true,
      candidates: [
        candidate({ model: GLM, ranks: { coding: rank('coding', 8) } }),
        candidate({ model: GLM_FLASH, ranks: { coding: rank('coding', 12) } }),
      ],
    });
    expect(result.model.openCodeId).toBe('glm-5.3-flash');
    expect(result.flashSwap?.passedOver.openCodeId).toBe('glm-5.3');
    expect(result.flashSwap?.passedOverRank).toBe(8);
    expect(result.flashSwap?.takenRank).toBe(12);
  });

  it('leaves a role with no flash variant alone', () => {
    const result = selectModel({
      profile: PROFILE,
      preferFlash: true,
      candidates: [
        candidate({
          model: model({ openCodeId: 'kimi-k3', id: 'kimi-k3' }),
          ranks: { coding: rank('coding', 4) },
        }),
      ],
    });
    expect(result.model.openCodeId).toBe('kimi-k3');
    expect(result.flashSwap).toBeUndefined();
  });

  it('keeps the model when the flash variant cannot call tools', () => {
    const result = selectModel({
      profile: PROFILE,
      preferFlash: true,
      candidates: [
        candidate({ model: GLM, ranks: { coding: rank('coding', 8) } }),
        candidate({
          model: model({ openCodeId: 'glm-5.3-flash', id: 'glm-5.3-flash', tools: false }),
          ranks: { coding: rank('coding', 12) },
        }),
      ],
    });
    expect(result.model.openCodeId).toBe('glm-5.3');
    expect(result.flashSwap).toBeUndefined();
  });

  it('takes a flash variant that does not clear the rank bar', () => {
    const result = selectModel({
      profile: { ...PROFILE, minimumRank: 40 },
      preferFlash: true,
      candidates: [
        candidate({ model: GLM, ranks: { coding: rank('coding', 8) } }),
        candidate({ model: GLM_FLASH, ranks: { coding: rank('coding', 60) } }),
      ],
    });
    expect(result.model.openCodeId).toBe('glm-5.3-flash');
    expect(result.rejected.map((entry) => entry.openCodeId)).not.toContain('glm-5.3-flash');
  });

  it('keeps the quality first pick when the preference is not asked for', () => {
    const result = selectModel({
      profile: PROFILE,
      candidates: [
        candidate({ model: GLM, ranks: { coding: rank('coding', 8) } }),
        candidate({ model: GLM_FLASH, ranks: { coding: rank('coding', 12) } }),
      ],
    });
    expect(result.model.openCodeId).toBe('glm-5.3');
    expect(result.flashSwap).toBeUndefined();
  });

  it('names the model it passed over and the rank of both', () => {
    const result = selectModel({
      profile: PROFILE,
      preferFlash: true,
      candidates: [
        candidate({ model: GLM, ranks: { coding: rank('coding', 8) } }),
        candidate({ model: GLM_FLASH, ranks: { coding: rank('coding', 12) } }),
      ],
    });
    expect(result.reason).toContain('coding rank 12');
    expect(result.reason).toContain('flash variant of glm-5.3 (coding rank 8)');
  });
});
