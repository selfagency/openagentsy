import type {
  PolicyAction,
  PolicyOrigin,
  PolicySeverity,
  RequestClassification,
} from '@openagentsy/core';

/**
 * The policy module interface (§21.1).
 *
 * A policy is a module with a stable id, a version and a decision. The id
 * is what a firing is attributed to and what a project enables or disables,
 * so it does not change when the behaviour does — the version changes then,
 * and the firing log records the version that was in force when the policy
 * fired.
 */

/** The layers of the guardrail stack (§17.4). */
export type PolicyLayer = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** The moments a policy is checked at (§21.1). */
export type PolicyMoment =
  | 'UserPromptSubmit'
  | 'PreToolCall'
  | 'PostToolCall'
  | 'PreResponse'
  | 'PostResponse'
  | 'PreCompact'
  | 'SubagentStop';

/** A file a call touches. */
export interface FileChange {
  /** The path the change writes to, when it names one. */
  path?: string;
  /** The path the change moves from, when it names one. */
  fromPath?: string;
}

/** What a policy found. */
export interface PolicyFinding {
  /** The policy that found it. */
  policyId: string;
  /** What kind of thing it is. */
  type: string;
  /** The text that matched. */
  match: string;
}

/**
 * What a policy is asked.
 *
 * The context carries what the policy needs and nothing else: the request
 * and its classification, the tool call and its result, the response, the
 * session the work happens in, the files it touches and the high-risk domain
 * the classifier fired on (§20.3).
 */
export interface PolicyContext {
  /** The request, and the classification of it. */
  request?: { text: string; classification?: RequestClassification };
  /** The tool call, when the policy is asked about one. */
  toolCall?: { name: string; args: unknown };
  /** The result of the tool call, when there is one. */
  toolResult?: { output: unknown };
  /** The response, when the policy is asked about one. */
  response?: { text: string };
  /** The session the work happens in. */
  session: { id: string; taskId?: string; roleId: string };
  /** The files the work touches. */
  files?: FileChange[];
  /** The high-risk domain the classifier fired on, when it fired (§20.3). */
  highRiskDomain?: string;
  /** The declared scope of the role (§22), when the role declares one. */
  scope?: { declaredPaths?: readonly string[] };
}

/**
 * What a policy decided.
 *
 * A policy that lets the thing through says so, a policy that notes
 * something flags it, a policy that stops it blocks it with a reason, and a
 * policy that changes it hands the change back.
 */
export type PolicyResult =
  | { action: 'allow' }
  | { action: 'flag'; findings: PolicyFinding[]; severity: PolicySeverity }
  | { action: 'block'; reason: string; finding?: PolicyFinding }
  | { action: 'transform'; payload: unknown };

/** A policy module. */
export interface PolicyModule {
  /** The stable id of the policy, e.g. `oa.anti-sycophancy`. */
  id: string;
  /** The version of the policy, e.g. `1.0.0`. */
  version: string;
  /** The layer of the guardrail stack the policy acts at (§17.4). */
  layer: PolicyLayer;
  /** What the policy is for, in a line. */
  description: string;
  /** The moments the policy is checked at. */
  appliesTo: PolicyMoment[];
  /** Whether the policy is ours or came from a plugin (§21). */
  origin: PolicyOrigin;
  /** The decision the policy makes. */
  evaluate: (ctx: PolicyContext) => PolicyResult;
}

/** The result of a policy that let the thing through. */
export function allow(): PolicyResult {
  return { action: 'allow' };
}

/** The result of a policy that noted something. */
export function flag(findings: PolicyFinding[], severity: PolicySeverity = 'warn'): PolicyResult {
  return { action: 'flag', findings, severity };
}

/** The result of a policy that stopped the thing. */
export function block(reason: string, finding?: PolicyFinding): PolicyResult {
  return finding === undefined ? { action: 'block', reason } : { action: 'block', reason, finding };
}

/**
 * The findings of a set of matches.
 *
 * The policy id is on every finding, so a finding that travels on its own
 * still says which policy produced it.
 */
export function findingsOf(
  policyId: string,
  type: string,
  matches: readonly string[],
): PolicyFinding[] {
  return matches.map((match) => ({ policyId, type, match }));
}

/** What a policy did, as the engine reports it. */
export type PolicyOutcome = {
  /** The policy that was asked. */
  policyId: string;
  /** The version it carried at that moment. */
  version: string;
  /** The layer it acts at. */
  layer: PolicyLayer;
  /** What it decided. */
  action: PolicyAction;
  /** The severity of a flag. */
  severity?: PolicySeverity | undefined;
  /** Why it acted. */
  reason?: string | undefined;
  /** What it found. */
  findings: PolicyFinding[];
};
