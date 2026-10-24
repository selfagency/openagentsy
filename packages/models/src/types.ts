export type ProviderId = 'opencode' | 'opencode-go' | 'ollama' | 'ollama-cloud';

export const PROVIDER_IDS: ProviderId[] = ['opencode', 'opencode-go', 'ollama', 'ollama-cloud'];

export type Surface = 'overall' | 'agentic' | 'coding';

export const SURFACES: Surface[] = ['overall', 'agentic', 'coding'];

export type EvidenceLabel = 'supported' | 'estimated';

export type Retention = {
  trainsOnPrompts: boolean;
  zeroDataRetention: boolean;
  retentionDays: number;
  source: string;
  checkedAt: string;
};

export type Quota = {
  monthlyCapUsd?: number;
  monthlyCapUsdPlus?: number;
  requestsPer5h?: number;
  requestsPer5hPlus?: number;
  source: string;
};

export type TokenCost = {
  /** Price per 1M input tokens, in dollars. */
  input: number;
  /** Price per 1M output tokens, in dollars. */
  output: number;
  /** Price per 1M cached read tokens, in dollars. */
  cacheRead?: number;
};

export type ProviderModel = {
  provider: ProviderId;
  /** The model id the provider serves it under. */
  id: string;
  /** The id OpenCode uses, provider/id. */
  openCodeId: string;
  name: string;
  tools: boolean;
  thinking: boolean;
  vision: boolean;
  reasoning: boolean;
  /** The reasoning effort levels the model actually offers. */
  variants: string[];
  contextWindow?: number;
  cost?: TokenCost;
  canonicalId?: string;
  creator?: string;
  releaseDate?: string;
};

export type RankEntry = {
  surface: Surface;
  rank: number;
  score: number;
  evidence: EvidenceLabel;
  scoreConfidence: number;
  creator?: string;
};

export type Candidate = {
  model: ProviderModel;
  ranks: Partial<Record<Surface, RankEntry>>;
  retention: Retention;
  quota?: Quota;
};

// The lock file has one definition, in lock-schema.ts, and the type is
// read out of the schema. A second copy drifts, and a drift is a field that
// disappears for one of the three packages that read the lock.
export type { ModelLock, ModelLockEntry } from './lock-schema.js';
