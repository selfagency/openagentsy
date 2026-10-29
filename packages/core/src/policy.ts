/**
 * The vocabulary the policy modules and the firing log share (§21).
 *
 * The types live here because two packages meet on them and neither of them
 * sits above the other: the hooks package writes the firings, the ledger
 * stores them, and the ledger sits below the hooks. A type that both of them
 * name cannot live in either of them, so it lives here, where both of them
 * can reach it.
 */

/**
 * The classification of a request — layer 1 of the guardrail stack (§17.4).
 *
 * It is what the policy selection reads (§21.4): the same classification
 * that names a high-risk domain is the one that adds the high-risk module to
 * the stack.
 */
export interface RequestClassification {
  /**
   * The high-risk domain the classifier fired on (§20.3), when it fired.
   *
   * The domain is a slug: `advice`, `crime`, `relational` and the rest of
   * §20.3. A classification that fired on no domain leaves it
   * out, and the stack is the baseline one.
   */
  highRiskDomain?: string | undefined;
  /** The confidence the classifier had, from 0 to 1. */
  confidence?: number | undefined;
  /** The domains the classifier saw, whether or not it fired on them. */
  domains?: readonly string[] | undefined;
}

/** What a policy did when it was asked. */
export type PolicyAction = 'allow' | 'flag' | 'block' | 'transform';

/** How serious a flag is. */
export type PolicySeverity = 'info' | 'warn' | 'error';

/**
 * Where a policy module came from.
 *
 * A first-party module is one of ours; an external one is a module a
 * downstream project brought. The two are told apart in the firing log, and
 * an external module does not count towards the first-party release criteria.
 */
export type PolicyOrigin = 'first-party' | 'external';

/**
 * A policy firing, as the log holds it (§21.3).
 *
 * The version is the version of the policy at the moment it fired, so a
 * regression can be attributed to the change that caused it rather than to
 * the policy in general.
 */
export interface PolicyFiring {
  /** The session the firing happened in. */
  sessionId: string;
  /** The stable id of the policy. */
  policyId: string;
  /** The version of the policy at the moment it fired. */
  policyVersion: string;
  /** The layer of the guardrail stack the policy acts at (§17.4). */
  layer: number;
  /** What the policy did. */
  action: PolicyAction;
  /** The severity of a flag. */
  severity?: PolicySeverity | undefined;
  /** Why the policy acted. */
  reason?: string | undefined;
  /** The quality finding the firing links to, when there is one. */
  findingId?: string | undefined;
  /** The classification the firing happened under. */
  classification?: string | undefined;
  /** Anything else the firing carries. */
  detail?: string | undefined;
  /** Whether the policy is first-party or came from a plugin. */
  origin?: PolicyOrigin | undefined;
  /** The moment the firing happened; the clock when it is not given. */
  ts?: string | undefined;
}

/**
 * Where the firings go.
 *
 * The engine writes through this and nothing else, so the log is a store and
 * not a memory: the caller decides which store the rows go into, and the
 * ledger is the one the plan names (§21.3).
 */
export type PolicyFiringSink = {
  /** Record one firing. */
  record: (firing: PolicyFiring) => void;
};
