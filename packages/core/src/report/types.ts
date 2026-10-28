/**
 * The facts of a run report (§12).
 *
 * The report is a rendering of facts, not a computation of them: every
 * number in it was read from a table or a store, and the module that renders
 * it never opens a file. So the facts carry the numbers and the module that
 * gathers them carries the knowledge of where they came from.
 *
 * A number that could not be read is absent rather than zero. A zero says
 * the cost was nothing, and an absent number says nobody knows: the report
 * that prints a zero where it has no measurement is a report that lies in
 * the way a person cannot see.
 */

/** An interval: the low end and the high end. */
export type ReportRange = readonly [lo: number, hi: number];

/**
 * A number that may not be known.
 *
 * The reason is carried with it, because "not computed" without a reason is
 * a shrug, and the reason is what tells a reader whether to look for the
 * counter or to let the number go.
 */
export type Measured = { known: true; value: number } | { known: false; reason: string };

/** The scope the report is about. */
export type ReportScope =
  /** The whole project: every row the ledger holds. */
  | { kind: 'project' }
  /** One session, and the subagents that rolled up into it. */
  | { kind: 'session'; id: string }
  /** One bean: the rows whose task is that bean. */
  | { kind: 'bean'; id: string }
  /** A window: the rows written since the instant. */
  | { kind: 'since'; days: number; label: string };

/** The tokens and the spend of one role. */
export type RoleCost = {
  /** The role the adapter resolved. */
  role: string;
  /** The tokens of the role. */
  tokens: number;
  /** The spend of the role, when it is known. */
  usd: number | null;
  /** The messages of the role that no source could price. */
  unpriced: number;
};

/**
 * The cost of the scope.
 *
 * Every number here is the ledger's `usage` table, read through the
 * ledger's own queries.
 */
export type CostFacts = {
  /** Whether the ledger holds a row for the scope. */
  present: boolean;
  /** The messages of the scope. */
  messages: number;
  /** The tokens of the scope. */
  tokens: number;
  /** The tokens per role, the largest first. */
  roles: RoleCost[];
  /** The spend the host reported. */
  reportedUsd: number | null;
  /** The spend the pricing chain estimated. */
  estimatedUsd: number | null;
  /** The models that no source could price. */
  unpricedModels: number;
  /** The messages that no source could price. */
  unpricedMessages: number;
};

/**
 * The footprint of the scope.
 *
 * The bounds are the ledger's `footprint` table: the estimate the estimator
 * produced, with the ends of the interval it produced it with.
 */
export type FootprintFacts = {
  /** Whether the table holds a row for the scope. */
  present: boolean;
  /** The electricity, in kilowatt hours. */
  energyKwh: ReportRange | null;
  /** The water, in litres. */
  waterL: ReportRange | null;
  /** The carbon, in kilograms of CO2. */
  co2Kg: ReportRange | null;
  /** The method the estimate was made under. */
  method: string | null;
  /** The input the answer leans on hardest. */
  dominantUncertainty: string | null;
  /** The grid the carbon came from, when the table records one. */
  grid: string | null;
  /** The providers of the scope that do not disclose their infrastructure. */
  undisclosedProviders: number;
};

/** The waste of one kind. */
export type WasteKind = {
  /** The kind of the signal, as the table names it. */
  kind: string;
  /** How many signals of the kind there are. */
  count: number;
  /** The tokens the signals were. */
  tokens: number;
  /** The share of the waste the kind is. */
  percentage: number;
};

/**
 * The waste of the scope.
 *
 * Every number here is the ledger's `waste` table, and the share is against
 * the tokens of the scope.
 */
export type WasteFacts = {
  /** Whether the table holds a row for the scope. */
  present: boolean;
  /** The waste tokens. */
  tokens: number;
  /** The share of the tokens of the scope that is waste. */
  percentage: number;
  /** The waste per kind, the largest first. */
  byKind: WasteKind[];
};

/**
 * The value of the scope.
 *
 * Every number here is the ledger's `outcome` table, and the offload line
 * is the ledger's offload rows.
 */
export type ValueFacts = {
  /** Whether the table holds a row for the scope. */
  present: boolean;
  /** The tasks that were completed. */
  tasksCompleted: number;
  /** The tasks that were scrapped. */
  tasksScrapped: number;
  /** The commits that were recorded. */
  commits: number;
  /** The pull requests that were merged. */
  prsMerged: number;
  /** The tokens one completed task cost, when there is a task. */
  tokensPerTask: number | null;
  /** The tokens one commit cost, when there is a commit. */
  tokensPerCommit: number | null;
  /** The offloaded messages. */
  offloadMessages: number;
  /** The tokens the offload kept off the cloud. */
  offloadTokens: number;
  /** What the offload cost. */
  offloadUsd: number | null;
  /** What the same tokens would have cost on the cloud. */
  offloadCloudUsd: number | null;
  /** The difference, when both numbers are known. */
  offloadSavedUsd: number | null;
};

/**
 * The oversight of the scope.
 *
 * The counts are the board's records, the lessons, the waivers, the audit
 * log and the findings store. The two that no package computes are carried
 * as `Measured` with the reason they are not known.
 */
export type OversightFacts = {
  /** The board records of the scope. */
  records: number;
  /** The lessons waiting for a person. */
  lessons: number;
  /** The memory candidates waiting for a person. */
  memory: number;
  /** The waivers a person recorded. */
  waivers: number;
  /** The lines of the audit log. */
  auditEntries: number;
  /** The floor findings that are open. */
  openFloor: number;
  /** The floor findings, and the tasks they belong to. */
  openFloorFindings: { taskId: string; ruleId: string; file: string; message: string }[];
  /** The board/report mismatches. */
  mismatches: Measured;
  /** The redactions. */
  redactions: Measured;
};

/**
 * The conformance of the project.
 *
 * Every number here is the conformance report of §11.
 */
export type ConformanceFacts = {
  /** The capabilities the report knows of. */
  total: number;
  /** The capabilities a live session showed working. */
  observed: number;
  /** The capabilities the project's own files show are there. */
  provenStatic: number;
  /** The capabilities nobody has verified. */
  unverified: number;
  /** The capabilities nobody has verified, by name. */
  unverifiedIds: string[];
  /** The warnings about the order the plugins load in. */
  pluginOrderWarnings: { plugin: string; detail: string }[];
};

/** The facts of a run report. */
export type ReportFacts = {
  /** The scope the report is about. */
  scope: ReportScope;
  /** The cost. */
  cost: CostFacts;
  /** The footprint. */
  footprint: FootprintFacts;
  /** The waste. */
  waste: WasteFacts;
  /** The value. */
  value: ValueFacts;
  /** The oversight. */
  oversight: OversightFacts;
  /** The conformance. */
  conformance: ConformanceFacts;
};
