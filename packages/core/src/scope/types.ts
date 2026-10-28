/**
 * The scope declaration (§22 of the Phase 2 plan).
 *
 * A role's permissions say what a role may *call*. A scope declaration says
 * what the role is *for*, and what it refuses to do. The two are different
 * things: a builder may call `edit`, and a builder is still not allowed to
 * write the file its lease does not cover.
 *
 * The declaration lives here, in code-readable data, and not in
 * `roles.yaml`: the roles file is a person's file, and the declaration has
 * to be matched against a request at runtime. The patch that puts the same
 * declaration into `roles.yaml` is proposed in the bean record.
 */

/** The state of a declaration's ethics review. */
export type ScopeReviewState =
  /** Written and proposed. It has not been through the maintainer review. */
  | 'proposed'
  /** Two maintainers have answered the twelve ethics questions. */
  | 'reviewed'
  /** The review refused the declaration. */
  | 'rejected';

/**
 * One entry of a scope list.
 *
 * The statement is what a person reads. The match phrases are what the
 * check uses: a request is out of scope when it carries one of them.
 *
 * An entry with no match phrase states a duty rather than a request to
 * refuse. It is printed, and it never blocks anything, because there is no
 * request that matches a duty.
 */
export type ScopeEntry = {
  /** What a person reads. */
  statement: string;
  /** The phrases that make a request match this entry. */
  match: string[];
};

/** How a declaration answers one ethics question. */
export type EthicsAnswer = {
  /** The question id, `oa.ethics.q01` and its eleven siblings. */
  id: string;
  /** How this declaration answers it. */
  how: string;
};

/** A question a declaration cannot answer, and why. */
export type EthicsGap = {
  /** The question id. */
  id: string;
  /** Why the declaration cannot answer it. */
  why: string;
};

/**
 * The review state of a declaration (§17.5).
 *
 * The review is a maintainer act: at least two maintainers answer the
 * twelve questions, and a change to a declaration goes through
 * `CHANGELOG-SAFETY.md`. A declaration that has not been through it is a
 * proposal, and it says so.
 */
export type ScopeReview = {
  /** Where the review stands. */
  state: ScopeReviewState;
  /** The questions this declaration answers, and how. */
  answered: EthicsAnswer[];
  /** The questions it cannot answer, and why. */
  unanswered: EthicsGap[];
  /** The maintainers who have reviewed it. Empty while it is a proposal. */
  reviewers: string[];
};

/**
 * A scope declaration.
 *
 * The shape is the one the plan gives, with one addition: `display`, so the
 * command can print `oa-lead (Lead)` without reading the roles file.
 */
export type ScopeDeclaration = {
  /** The role key, the same key `roles.yaml` uses. */
  role: string;
  /** The name a person reads. */
  display: string;
  /** What the role is for. */
  purpose: string;
  /** What the role does. */
  in_scope: ScopeEntry[];
  /** What the role refuses to do. */
  out_of_scope: ScopeEntry[];
  /** The sentence the refusal is built from. */
  refusal_pattern: string;
  /** Where the refused work goes. */
  redirect: string;
  /** The ethics review state. */
  review: ScopeReview;
};

/**
 * How many maintainers a declaration needs before it is reviewed.
 *
 * Two, so one person's opinion cannot change what a role may refuse.
 */
export const REQUIRED_REVIEWERS = 2;

/**
 * Whether a declaration has been through the review.
 *
 * A declaration with two reviewers and a `reviewed` state is the one a
 * maintainer signed. Everything else is a proposal.
 */
export function isReviewed(declaration: ScopeDeclaration): boolean {
  return (
    declaration.review.state === 'reviewed' &&
    declaration.review.reviewers.length >= REQUIRED_REVIEWERS
  );
}
