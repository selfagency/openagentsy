import type { ModelProfile } from '@openagentsy/core';
import type { Candidate, EvidenceLabel, ProviderModel, Surface } from './types.js';

export const LARGE_CONTEXT_TOKENS = 200_000;

export type SelectOptions = {
  profile: ModelProfile;
  candidates: Candidate[];
  /** Let a model that trains on prompts through. */
  allowTraining?: boolean | undefined;
  /** Let a model that is not zero data retention through. */
  allowRetention?: boolean | undefined;
  /** Creators to skip, so a reviewer is not the builder's own family. */
  excludeCreators?: string[] | undefined;
  /** How many ranks an Estimated model may lose to a Supported one. */
  evidenceMargin?: number | undefined;
  /** How many ranks a balanced role may trade for a cheaper model. */
  balanceWindow?: number | undefined;
  date?: string | undefined;
};

export type Rejection = {
  openCodeId: string;
  reason: string;
};

export type Selection = {
  model: ProviderModel;
  runnerUp?: ProviderModel;
  reason: string;
  evidence: {
    source: string;
    label?: EvidenceLabel;
    surface?: Surface;
    rank?: number;
    score?: number;
    date: string;
  };
  rejected: Rejection[];
};

const SURFACE_FOR_SIGNAL: Record<string, Surface | undefined> = {
  agentic: 'agentic',
  coding: 'coding',
  overall: 'overall',
  long_context: undefined,
};

/** A rough blended price, used to compare two models. */
export function blendedCost(model: ProviderModel): number {
  if (!model.cost) return 0;
  return model.cost.input + model.cost.output * 3;
}

/** The cheapest candidate, or undefined when there is none. */
function cheapestOf(candidates: Candidate[]): Candidate | undefined {
  return [...candidates].sort((a, b) => blendedCost(a.model) - blendedCost(b.model))[0];
}

function surfaceRank(candidate: Candidate, surface: Surface | undefined): number | undefined {
  if (!surface) return undefined;
  return candidate.ranks[surface]?.rank;
}

function passesRequirements(candidate: Candidate, profile: ModelProfile): string | undefined {
  for (const requirement of profile.hardRequirements) {
    if (requirement === 'tool_calls' && !candidate.model.tools) return 'no tool calling';
    if (requirement === 'reasoning_variants' && !candidate.model.reasoning) {
      return 'no reasoning variants';
    }
    if (requirement === 'large_context') {
      const context = candidate.model.contextWindow;
      if (context === undefined) return 'context window unknown';
      if (context < LARGE_CONTEXT_TOKENS) return `context window ${context} is too small`;
    }
  }
  if (profile.minimumContext !== undefined) {
    const context = candidate.model.contextWindow;
    if (context === undefined) return 'context window unknown';
    if (context < profile.minimumContext) {
      return `context window ${context} is below the ${profile.minimumContext} required`;
    }
  }
  if (profile.expectedCallsPer5h !== undefined) {
    const requests = candidate.quota?.requestsPer5h;
    if (requests !== undefined && requests < profile.expectedCallsPer5h) {
      return `quota of ${requests} requests per 5 hours is below the ${profile.expectedCallsPer5h} this role needs`;
    }
  }
  return undefined;
}

function passesPrivacy(candidate: Candidate, options: SelectOptions): string | undefined {
  if (candidate.retention.trainsOnPrompts && options.allowTraining !== true) {
    return 'trains on prompts';
  }
  if (!candidate.retention.zeroDataRetention && options.allowRetention !== true) {
    return `retains data for ${candidate.retention.retentionDays} days`;
  }
  return undefined;
}

/**
 * Pick the model for one role.
 *
 * The rules come straight from the plan: hard requirements and the privacy
 * filter eliminate candidates, the role's signal decides the order, the cost
 * stance decides how far down the order to trade, and a Supported rank beats
 * an Estimated one inside a small margin.
 */
export function selectModel(options: SelectOptions): Selection {
  const { profile, candidates } = options;
  const surface = SURFACE_FOR_SIGNAL[profile.primarySignal];
  const evidenceMargin = options.evidenceMargin ?? 3;
  const balanceWindow = options.balanceWindow ?? 5;
  const excluded = new Set((options.excludeCreators ?? []).map((creator) => creator.toLowerCase()));

  const rejected: Rejection[] = [];
  const eligible: Candidate[] = [];

  for (const candidate of candidates) {
    const id = candidate.model.openCodeId;

    if (excluded.has(candidate.model.creator?.toLowerCase() ?? '')) {
      rejected.push({ openCodeId: id, reason: 'same creator as the builder' });
      continue;
    }

    const requirement = passesRequirements(candidate, profile);
    if (requirement) {
      rejected.push({ openCodeId: id, reason: requirement });
      continue;
    }

    const privacy = passesPrivacy(candidate, options);
    if (privacy) {
      rejected.push({ openCodeId: id, reason: privacy });
      continue;
    }

    if (profile.minimumRank !== undefined) {
      const rank = surfaceRank(candidate, surface);
      if (rank === undefined) {
        rejected.push({ openCodeId: id, reason: 'unranked' });
        continue;
      }
      if (rank > profile.minimumRank) {
        rejected.push({ openCodeId: id, reason: `rank ${rank} is below the threshold` });
        continue;
      }
    }

    eligible.push(candidate);
  }

  if (eligible.length === 0) {
    throw new Error(
      `no model satisfies the ${profile.primarySignal} profile for this role. ` +
        `Rejected ${rejected.length} candidate(s): ${rejected
          .slice(0, 5)
          .map((entry) => `${entry.openCodeId} (${entry.reason})`)
          .join(', ')}`,
    );
  }

  const byRank = (a: Candidate, b: Candidate): number => {
    if (profile.primarySignal === 'long_context') {
      const diff = (b.model.contextWindow ?? 0) - (a.model.contextWindow ?? 0);
      if (diff !== 0) return diff;
    } else {
      const rankA = surfaceRank(a, surface) ?? Number.MAX_SAFE_INTEGER;
      const rankB = surfaceRank(b, surface) ?? Number.MAX_SAFE_INTEGER;
      if (rankA !== rankB) return rankA - rankB;
    }
    return blendedCost(a.model) - blendedCost(b.model);
  };

  const sorted = [...eligible].sort(byRank);
  const best = sorted[0];
  if (!best) {
    throw new Error(`no model meets the requirements for the ${profile.primarySignal} signal`);
  }

  let chosen = best;
  const reasonParts: string[] = [];

  if (profile.costStance === 'cheapest') {
    const cheapest = cheapestOf(eligible);
    if (!cheapest) throw new Error('no model meets the requirements');
    chosen = cheapest;
    reasonParts.push(
      profile.minimumRank === undefined
        ? 'cheapest model that meets the requirements'
        : 'cheapest model that clears the rank threshold',
    );
  } else if (profile.costStance === 'balanced') {
    const bestRank = surfaceRank(best, surface) ?? Number.MAX_SAFE_INTEGER;
    const withinWindow = eligible.filter((candidate) => {
      const rank = surfaceRank(candidate, surface) ?? Number.MAX_SAFE_INTEGER;
      return rank <= bestRank + balanceWindow;
    });
    const cheapest = cheapestOf(withinWindow);
    if (!cheapest) throw new Error('no model meets the requirements');
    chosen = cheapest;
    reasonParts.push(`best price within ${balanceWindow} ranks of the leader`);
  } else {
    reasonParts.push(profile.costStance === 'ignore_cost' ? 'highest ranked' : 'quality first');
  }

  const chosenRank = surfaceRank(chosen, surface);
  const chosenEvidence = surface ? chosen.ranks[surface]?.evidence : undefined;

  if (chosenEvidence === 'estimated' && chosenRank !== undefined) {
    const supported = eligible
      .filter((candidate) => {
        const rank = surfaceRank(candidate, surface);
        const evidence = surface ? candidate.ranks[surface]?.evidence : undefined;
        return (
          evidence === 'supported' &&
          rank !== undefined &&
          rank >= chosenRank &&
          rank <= chosenRank + evidenceMargin
        );
      })
      .sort((a, b) => (surfaceRank(a, surface) ?? 0) - (surfaceRank(b, surface) ?? 0))[0];
    if (supported) {
      chosen = supported;
      reasonParts.push('estimated evidence did not beat the supported model by enough');
    }
  }

  const runnerUp = sorted.find(
    (candidate) => candidate.model.openCodeId !== chosen.model.openCodeId,
  );

  const rank = surface ? chosen.ranks[surface]?.rank : undefined;
  const score = surface ? chosen.ranks[surface]?.score : undefined;
  const label = surface ? chosen.ranks[surface]?.evidence : undefined;

  if (rank !== undefined) {
    reasonParts.unshift(`${surface} rank ${rank}${label ? `, ${label} evidence` : ''}`);
  } else {
    reasonParts.unshift('no ranking, chosen on cost and requirements');
  }

  return {
    model: chosen.model,
    ...(runnerUp ? { runnerUp: runnerUp.model } : {}),
    reason: reasonParts.join(', '),
    evidence: {
      source: 'benchlm',
      ...(label ? { label } : {}),
      ...(surface ? { surface } : {}),
      ...(rank !== undefined ? { rank } : {}),
      ...(score !== undefined ? { score } : {}),
      date: options.date ?? new Date().toISOString().slice(0, 10),
    },
    rejected: sortRejections(rejected, candidates, surface),
  };
}

/**
 * Put the most interesting rejections first: the models that ranked better
 * than the one that was chosen. A rejection the user cannot see is a
 * decision they cannot check.
 */
function sortRejections(
  rejected: Rejection[],
  candidates: Candidate[],
  surface: Surface | undefined,
): Rejection[] {
  const rankOf = new Map<string, number | undefined>();
  for (const candidate of candidates) {
    rankOf.set(candidate.model.openCodeId, surfaceRank(candidate, surface));
  }
  return [...rejected].sort((a, b) => {
    const rankA = rankOf.get(a.openCodeId);
    const rankB = rankOf.get(b.openCodeId);
    if (rankA === undefined && rankB === undefined) return 0;
    if (rankA === undefined) return 1;
    if (rankB === undefined) return -1;
    return rankA - rankB;
  });
}
