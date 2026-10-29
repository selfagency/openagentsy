import type { PolicyFiring, PolicyFiringSink } from '@openagentsy/core';
import type {
  PolicyContext,
  PolicyModule,
  PolicyMoment,
  PolicyOutcome,
  PolicyResult,
} from './policy.js';
import type { PolicyRegistry, PolicySelection } from './policy-registry.js';

/**
 * The policy engine (§21.3).
 *
 * The engine asks the stack for a decision and records what it decided. The
 * record carries the id of the policy, the version it had at that moment,
 * the session and the outcome, so a regression is attributed to the version
 * that caused it.
 *
 * The engine writes through a sink and knows nothing of any store, so the
 * log is the caller's choice: the ledger is the one the plan names, and the
 * rows survive a restart because they are rows in a database and not words
 * in a process.
 */

/** The id of the row that records the assembled stack. */
export const STACK_POLICY_ID = 'oa.policy.stack';

/** The version of the stack row. */
export const STACK_POLICY_VERSION = '1.0.0';

/** What the engine is built with. */
export interface PolicyEngineOptions {
  /** Where the firings go; an engine without one records nothing. */
  sink?: PolicyFiringSink | undefined;
}

/**
 * The moment a context is about.
 *
 * A context with a tool call is about the call, one with a response is
 * about the reply, and one with a request is about the request. A context
 * with none of them is about nothing, and no policy runs.
 */
export function momentOf(ctx: PolicyContext): PolicyMoment | undefined {
  if (ctx.toolCall !== undefined) return 'PreToolCall';
  if (ctx.response !== undefined) return 'PreResponse';
  if (ctx.request !== undefined) return 'UserPromptSubmit';
  return undefined;
}

/**
 * A decision, as the engine reports it.
 *
 * A decision that allowed the thing through carries no findings, and a
 * decision that flagged carries the severity of the flag.
 */
export function outcomeOf(module: PolicyModule, result: PolicyResult): PolicyOutcome {
  const base = { policyId: module.id, version: module.version, layer: module.layer };
  switch (result.action) {
    case 'allow':
      return { ...base, action: 'allow', reason: result.reason, findings: [] };
    case 'flag':
      return { ...base, action: 'flag', severity: result.severity, findings: result.findings };
    case 'block':
      return {
        ...base,
        action: 'block',
        reason: result.reason,
        findings: result.finding === undefined ? [] : [result.finding],
      };
    case 'transform':
      return { ...base, action: 'transform', findings: [] };
  }
}

/** The engine of a registry. */
export class PolicyEngine {
  /** The registry the stack comes from. */
  private readonly registry: PolicyRegistry;
  /** Where the firings go. */
  private readonly sink: PolicyFiringSink | undefined;
  /** The sessions whose stack was already recorded. */
  private readonly assembled: Set<string> = new Set();

  /**
   * An engine of a registry.
   *
   * The engine holds no state beyond the sessions whose stack it recorded,
   * so it may be built once for a session and used for every call in it.
   */
  constructor(registry: PolicyRegistry, options: PolicyEngineOptions = {}) {
    this.registry = registry;
    this.sink = options.sink;
  }

  /**
   * Ask the stack, and record what it decided.
   *
   * The stack is recorded once per session: the first row of the session
   * carries the whole stack, so a reader can see what the session was
   * guarded by without reading every row.
   */
  evaluate(ctx: PolicyContext): PolicyOutcome[] {
    const classification = ctx.request?.classification ?? {};
    const selection = this.registry.explain(classification);
    this.recordStack(ctx, selection);

    const moment = momentOf(ctx);
    if (moment === undefined) return [];
    const outcomes: PolicyOutcome[] = [];
    for (const module of selection.modules) {
      if (!module.appliesTo.includes(moment)) continue;
      const result = module.evaluate(ctx);
      const outcome = outcomeOf(module, result);
      outcomes.push(outcome);
      this.record(ctx, module, outcome);
    }
    return outcomes;
  }

  /** The row that records the stack of a session. */
  private recordStack(ctx: PolicyContext, selection: PolicySelection): void {
    if (this.sink === undefined) return;
    if (this.assembled.has(ctx.session.id)) return;
    this.assembled.add(ctx.session.id);
    const stack = selection.modules.map((module) => ({
      id: module.id,
      version: module.version,
    }));
    this.sink.record({
      sessionId: ctx.session.id,
      policyId: STACK_POLICY_ID,
      policyVersion: STACK_POLICY_VERSION,
      layer: 2,
      action: 'allow',
      reason: 'stack-assembled',
      classification: ctx.highRiskDomain ?? ctx.request?.classification?.highRiskDomain,
      detail: JSON.stringify(stack),
      origin: 'first-party',
    });
  }

  /** The row that records one decision. */
  private record(ctx: PolicyContext, module: PolicyModule, outcome: PolicyOutcome): void {
    if (this.sink === undefined) return;
    const firing: PolicyFiring = {
      sessionId: ctx.session.id,
      policyId: outcome.policyId,
      policyVersion: outcome.version,
      layer: outcome.layer,
      action: outcome.action,
      severity: outcome.severity,
      reason: outcome.reason,
      classification: ctx.highRiskDomain ?? ctx.request?.classification?.highRiskDomain,
      origin: module.origin,
    };
    if (outcome.findings.length > 0) {
      firing.detail = JSON.stringify(outcome.findings);
    }
    this.sink.record(firing);
  }
}
