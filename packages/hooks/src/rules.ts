import type { PolicyFiringSink } from '@openagentsy/core';
import { approvalGate, createApprovalStore } from './approvals.js';
import { isDestructiveCommand } from './guards.js';
import { destructiveNeedsApproval } from './policies/destructive-needs-approval.js';
import { humanOnlyDecisions } from './policies/human-only-decisions.js';
import { noSkipGitHooks } from './policies/no-skip-git-hooks.js';
import { packageManager } from './policies/package-manager.js';
import { protectPolicy } from './policies/protect-policy.js';
import { secretScanWrites } from './policies/secret-scan-writes.js';
import { workspaceWritesOnly } from './policies/workspace-writes-only.js';
import { approvalPolicyRule, policyRule } from './policy-rule.js';
import { type QualityRuleOptions, qualityAfterWrite } from './quality/rule.js';
import type { Rule } from './registry.js';

export {
  commandSegments,
  contentOf,
  isDestructiveCommand,
  isProtected,
  scannedParts,
  shellViolation,
  shellWriteTargets,
  skipsGitHooks,
  substitutionPayloads,
  tokenise,
  usesOtherPackageManager,
} from './guards.js';

/**
 * The default rules.
 *
 * Seven rules, all of them checked before a tool call, and all of them
 * blocking: a call that trips one of them does not happen. The output
 * checks are the other half of the package, and they flag instead.
 *
 * Every one of them is a policy module (§21.2) behind the bridge of
 * `policy-rule.ts`: the module decides, the rule carries the decision, and
 * the evaluation leaves a row in the firing log. The ids are the legacy
 * ones, so a rule that is named in a test or in a record is still the rule
 * that name refers to.
 *
 * The readings the rules make - the command, the path, the content of a
 * write - live in `guards.ts`, so the policy modules read the same thing
 * the rules read.
 */

/** The options the default rules are built with. */
export interface DefaultRuleOptions {
  /** The workspace root: the project the agent works in. */
  workspace: string;
  /** The state root: where the `.openagentsy/` directory lives. */
  stateRoot: string;
  /** The home directory the worktrees live under; the home of the user by default. */
  home?: string;
  /**
   * The quality check, when the project runs one.
   *
   * A project that names no mode runs no check, so the rule is left out
   * rather than registered and idle.
   */
  quality?: Omit<QualityRuleOptions, 'workspace' | 'stateRoot'>;
  /**
   * Where the policy firings go.
   *
   * A rule without a sink decides and records nothing: the log is the
   * caller's choice, and a guard that runs without one still guards.
   */
  firings?: PolicyFiringSink | undefined;
}

/**
 * The seven default rules.
 *
 * They run in the order they are written, and every one of them blocks.
 */
export const defaultRules = ({
  workspace,
  stateRoot,
  home,
  quality,
  firings,
}: DefaultRuleOptions): Rule[] => {
  const approvals = createApprovalStore(stateRoot);
  // The firing sink is the same for every rule: the log is one log.
  const guard = { firings };
  return [
    ...(quality === undefined ? [] : [qualityAfterWrite({ workspace, stateRoot, ...quality })]),
    policyRule(noSkipGitHooks, {
      ...guard,
      id: 'no-skip-git-hooks',
      event: 'PreToolCall',
      block: true,
    }),
    policyRule(packageManager, {
      ...guard,
      id: 'package-manager',
      event: 'PreToolCall',
      block: true,
    }),
    policyRule(workspaceWritesOnly({ workspace, home }), {
      ...guard,
      id: 'workspace-writes-only',
      event: 'PreToolCall',
      block: true,
    }),
    policyRule(protectPolicy, {
      ...guard,
      id: 'protect-policy',
      event: 'PreToolCall',
      block: true,
    }),
    policyRule(humanOnlyDecisions, {
      ...guard,
      id: 'human-only-decisions',
      event: 'PreToolCall',
      block: true,
    }),
    policyRule(secretScanWrites, {
      ...guard,
      id: 'secret-scan-writes',
      event: 'PreToolCall',
      block: true,
    }),
    // The destructive rule asks a person, and a person answers out of band:
    // the gate is asynchronous and it spends a grant, so it cannot live in
    // the synchronous decision of a policy.
    approvalPolicyRule(destructiveNeedsApproval, {
      ...guard,
      id: 'destructive-needs-approval',
      event: 'PreToolCall',
      block: true,
      gate: approvalGate(isDestructiveCommand, approvals),
    }),
  ];
};
