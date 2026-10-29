import type { PolicyFiring, PolicyFiringSink } from '@openagentsy/core';
import { readPreToolCall } from './event.js';
import type {
  FileChange,
  PolicyContext,
  PolicyFinding,
  PolicyModule,
  PolicyResult,
} from './policy.js';
import type { HandlerResult, HookEvent, Rule } from './registry.js';

/**
 * The bridge between a policy module and a rule (§21.3).
 *
 * The policy modules are the decisions, and the registry runs rules. The
 * bridge is the seam between them: it reads the event into the context the
 * modules expect, asks the module, and maps the decision onto the outcome of
 * the rule. A rule that blocks is a rule that refuses, a rule that flags is a
 * rule that notes something and lets the call through, and a rule that
 * transforms hands the payload on.
 *
 * Every evaluation leaves a row behind. The row carries the id of the
 * policy, the version it carried at that moment, the layer it acts at, what
 * it decided and the session it happened in, so a regression is attributed
 * to the version that caused it. One evaluation is one row: a policy that
 * found three things wrote one row, not three.
 */

/** The session a context names when the event names none. */
export const UNKNOWN_SESSION_ID = 'unknown';

/** The role a context names when the event names none. */
export const UNKNOWN_ROLE_ID = 'unknown';

/**
 * The reason the row carries when a person approved the call.
 *
 * The approval is a fact about the call, and the row is where the facts
 * live: a call that went through because a person said so says so.
 */
export const APPROVED_REASON = 'a person approved it with `/oa approve`';

/** What the context is read with, when the event does not say. */
export interface PolicyContextOptions {
  /** The paths the active task may touch. */
  statedPaths?: readonly string[] | undefined;
  /** The role the call is made for, when the event names none. */
  roleId?: string | undefined;
  /** The session the call is made in, when the event names none. */
  sessionId?: string | undefined;
  /**
   * The high-risk domain the classifier fired on, when it fired (§20.3).
   *
   * The domain is a fact about the prose, and it reaches the policies
   * through the context: a policy that tightens its rules in a high-risk
   * domain reads it from there. The event carries it too, so a caller that
   * classified the prose does not have to name it a second time.
   */
  highRiskDomain?: string | undefined;
}

/** The event, when it is an object. */
function recordOf(event: unknown): Record<string, unknown> | undefined {
  if (typeof event !== 'object' || event === null) return undefined;
  return event as Record<string, unknown>;
}

/**
 * A string field of the event, when it is one.
 */
function stringField(event: unknown, name: string): string | undefined {
  const record = recordOf(event);
  if (record === undefined) return undefined;
  const value = record[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The context a policy is asked about (§21.1).
 *
 * The event is read the way the hook rules read it: the tool call is the
 * one the host named, the files are the ones the event carries, and the
 * reply is the text of the response. An event that names no session and no
 * role still gets a context: a policy that was asked about a call nobody
 * attributed still decides, and the row names the session it could not name.
 */
export function policyContextOf(event: unknown, options: PolicyContextOptions = {}): PolicyContext {
  const call = readPreToolCall(event);
  const sessionId =
    call?.sessionID ?? stringField(event, 'sessionID') ?? options.sessionId ?? UNKNOWN_SESSION_ID;
  const roleId = call?.role ?? stringField(event, 'role') ?? options.roleId ?? UNKNOWN_ROLE_ID;
  const ctx: PolicyContext = { session: { id: sessionId, roleId } };
  if (call !== undefined) {
    // The command is the one the host named, and a host names it either in
    // the arguments or beside them. The policy reads the command out of the
    // arguments, so the command the event named is put there: a policy that
    // read nothing where the host put the command would let the call
    // through.
    const args = call.command === undefined ? call.args : { ...call.args, command: call.command };
    ctx.toolCall = { name: call.toolName, args };
    const files: FileChange[] = call.files.map((file) => ({
      ...(file.path === undefined ? {} : { path: file.path }),
      ...(file.fromPath === undefined ? {} : { fromPath: file.fromPath }),
    }));
    ctx.files = files;
  }
  const text = stringField(event, 'text');
  if (text !== undefined) ctx.response = { text };
  const highRiskDomain = options.highRiskDomain ?? stringField(event, 'highRiskDomain');
  if (highRiskDomain !== undefined) ctx.highRiskDomain = highRiskDomain;
  if (options.statedPaths !== undefined && options.statedPaths.length > 0) {
    ctx.scope = { declaredPaths: options.statedPaths };
  }
  return ctx;
}

/** What the rule that runs a policy is built with. */
export interface PolicyRuleOptions extends PolicyContextOptions {
  /** The id of the rule; the id of the policy when it is not named. */
  id?: string | undefined;
  /** The moment the rule is checked at. */
  event?: HookEvent | undefined;
  /** Whether the rule blocks. */
  block?: boolean | undefined;
  /** Where the firings go; a rule without a sink records nothing. */
  firings?: PolicyFiringSink | undefined;
  /** Where the findings of a flag go. */
  onFindings?: ((findings: PolicyFinding[]) => void) | undefined;
  /** The id of the finding the firing links to, when there is one. */
  findingId?: string | undefined;
  /**
   * The reason the row carries, when the decision carries none of its own.
   *
   * A flag says nothing by itself, so a flag that has to be read says why
   * here: the domain it fired on and the evidence that found it.
   */
  reason?: string | undefined;
}

/**
 * The reason a decision carries, when it carries one.
 *
 * A block says why it stopped the thing, and an allow says why it let it
 * through - an approval, mostly. A flag says nothing by itself: the findings
 * of a flag are the row's detail, and a flag that was given a reason carries
 * it in the options. A transform carries a payload and not a reason.
 */
function reasonOf(result: PolicyResult): string | undefined {
  if (result.action === 'block') return result.reason;
  if (result.action === 'allow') return result.reason;
  return undefined;
}

/**
 * The findings a decision carries.
 *
 * A block carries at most one, and a flag carries all of them. The row
 * holds them as its detail: one row for the evaluation, and the findings
 * inside it.
 */
function findingsOf(result: PolicyResult): PolicyFinding[] {
  if (result.action === 'flag') return result.findings;
  if (result.action === 'block' && result.finding !== undefined) return [result.finding];
  return [];
}

/**
 * Record one evaluation (§21.3).
 *
 * The row carries what a reader needs to attribute a decision: the policy,
 * the version it carried at that moment, the layer, the action, the severity
 * of a flag, the reason of a block (or of a flag that was given one) and the
 * session it happened in. The findings of the decision go into the detail of
 * the row, so a row that fired on three findings is still one row.
 *
 * A sink that is not there records nothing: a rule that runs without a log
 * still decides.
 */
export function recordPolicyFiring(
  sink: PolicyFiringSink | undefined,
  module: PolicyModule,
  result: PolicyResult,
  ctx: PolicyContext,
  options: { findingId?: string | undefined; reason?: string | undefined } = {},
): void {
  if (sink === undefined) return;
  const firing: PolicyFiring = {
    sessionId: ctx.session.id,
    policyId: module.id,
    policyVersion: module.version,
    layer: module.layer,
    action: result.action,
    severity: result.action === 'flag' ? result.severity : undefined,
    reason: reasonOf(result) ?? options.reason,
    classification: ctx.highRiskDomain ?? ctx.request?.classification?.highRiskDomain,
    origin: module.origin,
    ...(options.findingId === undefined ? {} : { findingId: options.findingId }),
  };
  const findings = findingsOf(result);
  if (findings.length > 0) firing.detail = JSON.stringify(findings);
  sink.record(firing);
}

/**
 * The outcome of a rule, from the decision of a policy.
 *
 * A flag is not a stop: the findings go to the sink and the call goes on. A
 * block refuses with the reason of the policy. A transform hands the payload
 * on, and the caller applies it.
 */
function outcomeOf(result: PolicyResult, options: PolicyRuleOptions): HandlerResult {
  switch (result.action) {
    case 'allow':
      return { continue: true };
    case 'flag':
      options.onFindings?.(result.findings);
      return { continue: true };
    case 'block':
      return { continue: false, reason: result.reason };
    case 'transform':
      return { transform: result.payload };
  }
}

/**
 * The rule that runs a policy.
 *
 * The rule is what the registry runs and the policy is what decides, so the
 * id of the rule is the legacy id of the guard it replaced and the id of the
 * policy is what the row carries. The two are told apart on purpose: a
 * reader of the log looks for the policy, and a reader of the rules looks
 * for the rule.
 */
export function policyRule(module: PolicyModule, options: PolicyRuleOptions = {}): Rule {
  return {
    id: options.id ?? module.id,
    event: options.event ?? 'PreToolCall',
    ...(options.block === undefined ? {} : { block: options.block }),
    handler: (event) => {
      const ctx = policyContextOf(event, options);
      const result = module.evaluate(ctx);
      recordPolicyFiring(options.firings, module, result, ctx, options);
      return outcomeOf(result, options);
    },
  };
}

/** What the rule that asks a person is built with. */
export interface ApprovalPolicyRuleOptions extends PolicyRuleOptions {
  /**
   * The gate that asks a person.
   *
   * The gate is asynchronous and it consumes a grant, so it cannot live in
   * the synchronous `evaluate` of a policy. The policy decides what the call
   * is, and the gate says whether a person allowed it.
   */
  gate: (event: unknown) => Promise<HandlerResult>;
  /** The reason the row carries when a person approved the call. */
  approvedReason?: string | undefined;
}

/**
 * The rule that runs a policy and asks a person.
 *
 * The policy says the call is destructive, and the gate asks whether a
 * person approved it. The row says what happened: a block with the reason
 * of the gate when the gate refused, and an allow with the approval as its
 * reason when the gate let the call through.
 */
export function approvalPolicyRule(module: PolicyModule, options: ApprovalPolicyRuleOptions): Rule {
  return {
    id: options.id ?? module.id,
    event: options.event ?? 'PreToolCall',
    ...(options.block === undefined ? {} : { block: options.block }),
    handler: async (event) => {
      const ctx = policyContextOf(event, options);
      const decision = module.evaluate(ctx);
      const result = await options.gate(event);
      if ('transform' in result) {
        recordPolicyFiring(options.firings, module, decision, ctx, options);
        return result;
      }
      if (result.continue === false) {
        recordPolicyFiring(
          options.firings,
          module,
          { action: 'block', reason: result.reason },
          ctx,
          options,
        );
        return result;
      }
      const reason =
        decision.action === 'block'
          ? (options.approvedReason ?? APPROVED_REASON)
          : decision.action === 'allow'
            ? decision.reason
            : undefined;
      recordPolicyFiring(
        options.firings,
        module,
        { action: 'allow', ...(reason === undefined ? {} : { reason }) },
        ctx,
        options,
      );
      return result;
    },
  };
}
