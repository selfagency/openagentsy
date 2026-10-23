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

/** The reason one hard requirement cuts a candidate, or nothing when it passes. */
function hardRequirementRejection(candidate: Candidate, requirement: string): string | undefined {
  if (requirement === 'tool_calls' && !candidate.model.tools) return 'no tool calling';
  if (requirement === 'reasoning_variants' && !candidate.model.reasoning) {
    return 'no reasoning variants';
  }
  if (requirement === 'large_context') {
    const context = candidate.model.contextWindow;
    if (context === undefined) return 'context window unknown';
    if (context < LARGE_CONTEXT_TOKENS) return `context window ${context} is too small`;
  }
  return undefined;
}

function passesRequirements(candidate: Candidate, profile: ModelProfile): string | undefined {
  for (const requirement of profile.hardRequirements) {
    const reason = hardRequirementRejection(candidate, requirement);
    if (reason) return reason;
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

/** The candidates one profile eliminates, with the reason each was cut. */
function filterCandidates(
  candidates: Candidate[],
  profile: ModelProfile,
  surface: Surface | undefined,
  options: SelectOptions,
): { eligible: Candidate[]; rejected: Rejection[] } {
  const excluded = new Set((options.excludeCreators ?? []).map((creator) => creator.toLowerCase()));
  const rejected: Rejection[] = [];
  const eligible: Candidate[] = [];

  for (const candidate of candidates) {
    const id = candidate.model.openCodeId;
    const reason =
      (excluded.has(candidate.model.creator?.toLowerCase() ?? '')
        ? 'same creator as the builder'
        : undefined) ??
      passesRequirements(candidate, profile) ??
      passesPrivacy(candidate, options) ??
      rankRejection(candidate, profile, surface);

    if (reason) {
      rejected.push({ openCodeId: id, reason });
    } else {
      eligible.push(candidate);
    }
  }

  return { eligible, rejected };
}

/** The rank-based rejection, or nothing when the candidate clears the threshold. */
function rankRejection(
  candidate: Candidate,
  profile: ModelProfile,
  surface: Surface | undefined,
): string | undefined {
  if (profile.minimumRank === undefined) return undefined;
  const rank = surfaceRank(candidate, surface);
  if (rank === undefined) return 'unranked';
  if (rank > profile.minimumRank) return `rank ${rank} is below the threshold`;
  return undefined;
}

/** The candidate the cost stance picks, with the reason it was picked. */
function applyCostStance(
  eligible: Candidate[],
  best: Candidate,
  profile: ModelProfile,
  surface: Surface | undefined,
  balanceWindow: number,
): { chosen: Candidate; reasonParts: string[] } {
  const reasonParts: string[] = [];

  if (profile.costStance === 'cheapest') {
    const cheapest = cheapestOf(eligible);
    if (!cheapest) throw new Error('no model meets the requirements');
    reasonParts.push(
      profile.minimumRank === undefined
        ? 'cheapest model that meets the requirements'
        : 'cheapest model that clears the rank threshold',
    );
    return { chosen: cheapest, reasonParts };
  }

  if (profile.costStance === 'balanced') {
    const bestRank = surfaceRank(best, surface) ?? Number.MAX_SAFE_INTEGER;
    const withinWindow = eligible.filter((candidate) => {
      const rank = surfaceRank(candidate, surface) ?? Number.MAX_SAFE_INTEGER;
      return rank <= bestRank + balanceWindow;
    });
    const cheapest = cheapestOf(withinWindow);
    if (!cheapest) throw new Error('no model meets the requirements');
    reasonParts.push(`best price within ${balanceWindow} ranks of the leader`);
    return { chosen: cheapest, reasonParts };
  }

  reasonParts.push(profile.costStance === 'ignore_cost' ? 'highest ranked' : 'quality first');
  return { chosen: best, reasonParts };
}

/** The supported model that beats an estimated one inside the margin, or nothing. */
function supportedAlternative(
  eligible: Candidate[],
  chosen: Candidate,
  surface: Surface | undefined,
  evidenceMargin: number,
): Candidate | undefined {
  const chosenRank = surfaceRank(chosen, surface);
  const chosenEvidence = surface ? chosen.ranks[surface]?.evidence : undefined;
  if (chosenEvidence !== 'estimated' || chosenRank === undefined) return undefined;

  return eligible
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
}

/** The order the role's signal decides: the leader first, then by blended cost. */
function byRank(
  profile: ModelProfile,
  surface: Surface | undefined,
): (a: Candidate, b: Candidate) => number {
  return (a, b) => {
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
}

/** The reason the choice carries, led by the rank it has. */
function reasonOf(chosen: Candidate, surface: Surface | undefined, stanceParts: string[]): string {
  const rank = surface ? chosen.ranks[surface]?.rank : undefined;
  const label = surface ? chosen.ranks[surface]?.evidence : undefined;
  const parts = [...stanceParts];
  if (rank !== undefined) {
    parts.unshift(`${surface} rank ${rank}${label ? `, ${label} evidence` : ''}`);
  } else {
    parts.unshift('no ranking, chosen on cost and requirements');
  }
  return parts.join(', ');
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

  const { eligible, rejected } = filterCandidates(candidates, profile, surface, options);
  if (eligible.length === 0) {
    throw new Error(
      `no model satisfies the ${profile.primarySignal} profile for this role. ` +
        `Rejected ${rejected.length} candidate(s): ${rejected
          .slice(0, 5)
          .map((entry) => `${entry.openCodeId} (${entry.reason})`)
          .join(', ')}`,
    );
  }

  const sorted = [...eligible].sort(byRank(profile, surface));
  const best = sorted[0];
  if (!best) {
    throw new Error(`no model meets the requirements for the ${profile.primarySignal} signal`);
  }

  const stance = applyCostStance(eligible, best, profile, surface, balanceWindow);
  let chosen = stance.chosen;

  const supported = supportedAlternative(eligible, chosen, surface, evidenceMargin);
  if (supported) {
    chosen = supported;
    stance.reasonParts.push('estimated evidence did not beat the supported model by enough');
  }

  const runnerUp = sorted.find(
    (candidate) => candidate.model.openCodeId !== chosen.model.openCodeId,
  );

  const rank = surface ? chosen.ranks[surface]?.rank : undefined;
  const score = surface ? chosen.ranks[surface]?.score : undefined;
  const label = surface ? chosen.ranks[surface]?.evidence : undefined;

  return {
    model: chosen.model,
    ...(runnerUp ? { runnerUp: runnerUp.model } : {}),
    reason: reasonOf(chosen, surface, stance.reasonParts),
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
