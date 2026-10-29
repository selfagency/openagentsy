/**
 * The types of the release check (§18.3 of the Phase 2 plan).
 *
 * A release check answers one question: does this release meet the criteria
 * the framework states? The answer is a verdict per criterion, a reason for
 * every verdict that is not a pass, and an exit code.
 *
 * The severity follows the decision the human made on 2026-10-29: a
 * first-party release is held to the criteria hard, and a library is held to
 * them softly. A hard failure does not ship; a soft failure is reported and
 * does not block.
 */

/** What is being released. */
export type ReleaseScope = 'first-party' | 'library';

/** How hard the criteria are held for this release. */
export type ReleaseSeverity = 'hard' | 'soft';

/**
 * The verdict of one criterion.
 *
 * `unknown` is the verdict of a criterion the check could not read: a
 * criterion nobody has answered, or a fact the check cannot see. It is not
 * a pass, and the report never counts it as one.
 */
export type ReleaseVerdict = 'pass' | 'fail' | 'unknown' | 'not-applicable';

/** What a criterion belongs to. */
export type CriterionKind = 'ethics' | 'safety' | 'governance';

/**
 * Who answers a criterion.
 *
 * A machine criterion is answered by reading the project's own state. A
 * person criterion is answered by a person, and the check asks for the answer
 * rather than guessing it. A criterion of both kinds carries both answers.
 */
export type CriterionSource = 'machine' | 'person' | 'both';

/** One check of one criterion. */
export type ReleaseCheck = {
  /** What the check found. */
  verdict: 'pass' | 'fail' | 'unknown';
  /** Why, in one line. */
  reason: string;
};

/** One criterion, and what the check found. */
export type ReleaseCriterion = {
  /** The stable id of the criterion, `oa.safety.rc01` and its siblings. */
  id: string;
  /** What the criterion asks for, in a line. */
  title: string;
  /** What the criterion belongs to. */
  kind: CriterionKind;
  /** Who answers it. */
  source: CriterionSource;
  /** How hard it is held. */
  severity: ReleaseSeverity;
  /** The verdict of the criterion. */
  verdict: ReleaseVerdict;
  /** The reason for the verdict, in one line. */
  reason: string;
  /** What the machine found, when a machine looked. */
  machine?: ReleaseCheck | undefined;
  /** What the person answered, when a person answered. */
  person?: ReleaseCheck | undefined;
  /** The documented exception, when the person recorded one. */
  exception?: string | undefined;
};

/** How many criteria of each verdict there are. */
export type ReleaseCounts = {
  /** Every criterion the report carries. */
  total: number;
  /** The criteria that pass. */
  pass: number;
  /** The criteria that fail. */
  fail: number;
  /** The criteria the check could not read. */
  unknown: number;
  /** The criteria that do not apply to this release. */
  notApplicable: number;
  /** How many criteria a machine answered. */
  machine: number;
  /** How many criteria a person answered. */
  person: number;
  /** How many criteria carry both answers. */
  both: number;
};

/** The report of a release check. */
export type ReleaseReport = {
  /** What is being released. */
  scope: ReleaseScope;
  /** How hard the criteria are held. */
  severity: ReleaseSeverity;
  /** The name of the package. */
  packageName: string;
  /** The version of the release. */
  version: string;
  /** Every criterion, in the order the framework states them. */
  criteria: ReleaseCriterion[];
  /** How many criteria of each verdict there are. */
  counts: ReleaseCounts;
  /** The ids a person still has to answer. */
  askedFor: string[];
  /** The ids the framework carries that the check does not know. */
  unknownIds: string[];
  /** The exit code the command returns. */
  exitCode: number;
  /** The problem with the project, when there is one. */
  problem?: string | undefined;
};
