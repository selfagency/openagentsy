import type { ModelProfile } from '@openagentsy/core';
import type { Candidate, EvidenceLabel, ProviderModel, Surface } from './types.js';

export const LARGE_CONTEXT_TOKENS = 200_000;

/**
 * The candidate set, with the preferences that ride with it.
 *
 * The lock builder picks a model for every role from one set and takes no
 * preference of its own, so a preference that applies to every role travels
 * with the set. The flash preference is one: every role applies it, and
 * every role still decides on its own whether the flash variant qualifies.
 */
export type CandidateSet = Candidate[] & { preferFlash?: boolean };

/** The candidate set, with the flash preference turned on. */
export function withFlashPreference(candidates: Candidate[]): CandidateSet {
  return Object.assign([...candidates], { preferFlash: true });
}

/** Whether the candidate set asks for the flash preference. */
function prefersFlash(candidates: Candidate[]): boolean {
  return (candidates as CandidateSet).preferFlash === true;
}

export type SelectOptions = {
  profile: ModelProfile;
  candidates: Candidate[];
  /**
   * Take the flash variant of the family the role would get, when it
   * qualifies. The default is quality first, and this is the flag that
   * trades a rank for the cheaper model of the same family.
   */
  preferFlash?: boolean | undefined;
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
  /** The flash variant that was taken instead of the model the role would have got. */
  flashSwap?: FlashSwap;
};

/** What the flash preference changed, so the report can show what it cost. */
export type FlashSwap = {
  /** The model the quality first pick made. */
  passedOver: ProviderModel;
  /** The rank of the model that was passed over, on the role's signal. */
  passedOverRank?: number;
  /** The rank of the flash variant that was taken instead. */
  takenRank?: number;
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

const FLASH_SUFFIX = '-flash';

/** The model id without the tag of a build: deepseek-v4.1-flash:1017 is deepseek-v4.1-flash. */
function withoutTag(id: string): string {
  const index = id.indexOf(':');
  return index === -1 ? id : id.slice(0, index);
}

/** Whether the model is the flash variant of its family. */
function isFlashVariant(id: string): boolean {
  const index = id.indexOf(':');
  const tag = index === -1 ? undefined : id.slice(index + 1).toLowerCase();
  if (tag === 'flash') return true;
  return withoutTag(id).toLowerCase().endsWith(FLASH_SUFFIX);
}

/**
 * The family a model belongs to: the same model without the flash marker.
 *
 * glm-5.3 and glm-5.3-flash are one family, and so are deepseek-v4.1 and
 * deepseek-v4.1-flash. The tag of a build is not part of the family.
 */
function familyOf(id: string): string {
  const base = withoutTag(id).toLowerCase();
  return base.endsWith(FLASH_SUFFIX) ? base.slice(0, -FLASH_SUFFIX.length) : base;
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

/**
 * The flash variant of the chosen model's family, when it qualifies.
 *
 * The variant has to pass what the chosen model passes: the same hard
 * requirements and the same privacy terms. It does not have to clear the
 * rank bar, because trading the rank is the point of the preference. The
 * variant has to come from the same provider, so a switch does not move a
 * role to a provider the switch did not name.
 */
function flashVariantOf(
  chosen: Candidate,
  candidates: Candidate[],
  profile: ModelProfile,
  surface: Surface | undefined,
  options: SelectOptions,
): Candidate | undefined {
  if (isFlashVariant(chosen.model.id)) return undefined;

  const family = familyOf(chosen.model.id);
  const excluded = new Set((options.excludeCreators ?? []).map((creator) => creator.toLowerCase()));

  const variants = candidates.filter(
    (candidate) =>
      candidate.model.provider === chosen.model.provider &&
      isFlashVariant(candidate.model.id) &&
      familyOf(candidate.model.id) === family,
  );

  const eligible = variants.filter((candidate) => {
    if (excluded.has(candidate.model.creator?.toLowerCase() ?? '')) return false;
    return (
      passesRequirements(candidate, profile) === undefined &&
      passesPrivacy(candidate, options) === undefined
    );
  });

  return eligible.sort(byRank(profile, surface))[0];
}

/** The reason the choice carries, led by the rank it has. */
function reasonOf(
  chosen: Candidate,
  surface: Surface | undefined,
  stanceParts: string[],
  flashSwap: FlashSwap | undefined,
): string {
  const rank = surface ? chosen.ranks[surface]?.rank : undefined;
  const label = surface ? chosen.ranks[surface]?.evidence : undefined;
  const parts = [...stanceParts];
  if (rank !== undefined) {
    parts.unshift(`${surface} rank ${rank}${label ? `, ${label} evidence` : ''}`);
  } else {
    parts.unshift('no ranking, chosen on cost and requirements');
  }
  if (flashSwap) {
    parts.push(
      `flash variant of ${flashSwap.passedOver.id}${rankText(flashSwap.passedOverRank, surface)}`,
    );
  }
  return parts.join(', ');
}

/** The rank of the model that was passed over, in the report. */
function rankText(rank: number | undefined, surface: Surface | undefined): string {
  if (rank === undefined) return '';
  return surface ? ` (${surface} rank ${rank})` : ` (rank ${rank})`;
}

/** The evidence the lock records for a choice. */
function evidenceOf(
  chosen: Candidate,
  surface: Surface | undefined,
  date: string | undefined,
): Selection['evidence'] {
  const rank = surface ? chosen.ranks[surface]?.rank : undefined;
  const score = surface ? chosen.ranks[surface]?.score : undefined;
  const label = surface ? chosen.ranks[surface]?.evidence : undefined;
  return {
    source: 'benchlm',
    ...(label ? { label } : {}),
    ...(surface ? { surface } : {}),
    ...(rank !== undefined ? { rank } : {}),
    ...(score !== undefined ? { score } : {}),
    date: date ?? new Date().toISOString().slice(0, 10),
  };
}

/**
 * The flash variant of the choice, when the preference takes one.
 *
 * The preference runs after the quality first pick, so the report can name
 * the model the role would have got and the one it took instead.
 */
function applyFlashPreference(
  chosen: Candidate,
  candidates: Candidate[],
  profile: ModelProfile,
  surface: Surface | undefined,
  options: SelectOptions,
): { chosen: Candidate; flashSwap?: FlashSwap } {
  if (options.preferFlash !== true && !prefersFlash(candidates)) return { chosen };

  const flash = flashVariantOf(chosen, candidates, profile, surface, options);
  if (!flash) return { chosen };

  const passedOverRank = surfaceRank(chosen, surface);
  const takenRank = surfaceRank(flash, surface);
  return {
    chosen: flash,
    flashSwap: {
      passedOver: chosen.model,
      ...(passedOverRank !== undefined ? { passedOverRank } : {}),
      ...(takenRank !== undefined ? { takenRank } : {}),
    },
  };
}

/** The message when no candidate satisfies the profile. */
function noCandidateMessage(profile: ModelProfile, rejected: Rejection[]): string {
  return (
    `no model satisfies the ${profile.primarySignal} profile for this role. ` +
    `Rejected ${rejected.length} candidate(s): ${rejected
      .slice(0, 5)
      .map((entry) => `${entry.openCodeId} (${entry.reason})`)
      .join(', ')}`
  );
}

/**
 * Pick the model for one role.
 *
 * The rules come straight from the plan: hard requirements and the privacy
 * filter eliminate candidates, the role's signal decides the order, the cost
 * stance decides how far down the order to trade, and a Supported rank beats
 * an Estimated one inside a small margin.
 *
 * The flash preference is the one thing that runs after all of that: it
 * swaps the model for the flash variant of its own family, so the report
 * carries the rank of the model that was passed over as well.
 */
export function selectModel(options: SelectOptions): Selection {
  const { profile, candidates } = options;
  const surface = SURFACE_FOR_SIGNAL[profile.primarySignal];
  const evidenceMargin = options.evidenceMargin ?? 3;
  const balanceWindow = options.balanceWindow ?? 5;

  const { eligible, rejected } = filterCandidates(candidates, profile, surface, options);
  if (eligible.length === 0) {
    throw new Error(noCandidateMessage(profile, rejected));
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

  const flash = applyFlashPreference(chosen, candidates, profile, surface, options);
  chosen = flash.chosen;

  const runnerUp = sorted.find(
    (candidate) => candidate.model.openCodeId !== chosen.model.openCodeId,
  );

  return {
    model: chosen.model,
    ...(runnerUp ? { runnerUp: runnerUp.model } : {}),
    reason: reasonOf(chosen, surface, stance.reasonParts, flash.flashSwap),
    evidence: evidenceOf(chosen, surface, options.date),
    rejected: sortRejections(rejected, candidates, surface).filter(
      (entry) => entry.openCodeId !== chosen.model.openCodeId,
    ),
    ...(flash.flashSwap ? { flashSwap: flash.flashSwap } : {}),
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
