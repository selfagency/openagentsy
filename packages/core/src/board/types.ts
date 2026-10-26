export const RECORD_KINDS = ['status', 'contract', 'question', 'blocker', 'finding'] as const;

export type RecordKind = (typeof RECORD_KINDS)[number];

export const CONFIDENCE_LEVELS = ['verified', 'inferred', 'guess'] as const;

export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export type BoardRecord = {
  id: number;
  bean: string;
  kind: RecordKind;
  from: string;
  to?: string;
  action: string;
  state: string;
  artifact?: string;
  contract?: unknown;
  needs?: string;
  surprise?: string;
  confidence: Confidence;
  read: boolean;
  createdAt: string;
};

export type PostRecordInput = {
  bean: string;
  kind: RecordKind;
  from: string;
  action: string;
  state: string;
  confidence: Confidence;
  to?: string | undefined;
  artifact?: string | undefined;
  contract?: unknown;
  needs?: string | undefined;
  surprise?: string | undefined;
};

export type Lease = {
  id: number;
  bean: string;
  agent: string;
  glob: string;
  grantedAt: string;
};

export type LeaseDecision = {
  path: string;
  status: 'unleased' | 'leased' | 'conflict';
  agent?: string;
  bean?: string;
  glob?: string;
};

export type Budget = {
  bean: string;
  tokenLimit: number;
  stopAt: number;
  tokensUsed: number;
  /** The cap of a single turn, when the bean has one. */
  turnLimit?: number | undefined;
  /** The cap of a single session, when the bean has one. */
  sessionLimit?: number | undefined;
  /** The scope that was warned about, when the bean is in the yellow window. */
  warned?: string | undefined;
  updatedAt: string;
};

export type BudgetDecision = {
  bean: string;
  tokenLimit: number;
  stopAt: number;
  tokensUsed: number;
  stop: boolean;
  configured: boolean;
  /** The cap of a single turn, when the bean has one. */
  turnLimit?: number | undefined;
  /** The tokens of the most expensive turn that was measured. */
  turnTokens?: number | undefined;
  /** Whether the most expensive turn went over its cap. */
  turnStop: boolean;
  /** The cap of a single session, when the bean has one. */
  sessionLimit?: number | undefined;
  /** The tokens of the most expensive session that was measured. */
  sessionTokens?: number | undefined;
  /** Whether the most expensive session went over its cap. */
  sessionStop: boolean;
  /** The yellow window: the warning this check owes, when it owes one. */
  warning?: string | undefined;
};
