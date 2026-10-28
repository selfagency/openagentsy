import type { RequestClassification } from '@openagentsy/core';
import type { PolicyModule } from '../policy.js';
import { HIGH_RISK_PREFIX } from './high-risk.js';

/**
 * The selection of the policy stack (§21.4).
 *
 * The stack is assembled from the classification of the request, and the
 * assembly is explainable: every module that was selected says why it was
 * selected, so a reader can tell a guardrail that was always on from one
 * that the classifier brought in.
 */

/**
 * The stack every session gets (§21.4).
 *
 * The list is the one §21.4 names, with `oa.structural-bias` added: the
 * detector of §21.5 is a layer 4 module, and a module that is not in the
 * stack never runs.
 */
const BASELINE_POLICY_IDS: readonly string[] = [
  'oa.truthfulness-uncertainty',
  'oa.anti-sycophancy',
  'oa.anti-anthropomorphism',
  'oa.anti-dependence',
  'oa.agi-framing',
  'oa.professional-displacement',
  'oa.structural-bias',
  'oa.dark-pattern',
  'oa.scope-enforcement',
  'oa.privacy-transparency',
  'oa.third-party-impact',
];

/**
 * The stack that is on every tool call (§21.2, layer 1).
 *
 * These are the guardrails that hold whatever the request is: the git
 * hooks, the package manager, the writes, the files a person changes, the
 * decisions a person makes, the secrets and the destructive commands.
 */
const ALWAYS_ON_POLICY_IDS: readonly string[] = [
  'oa.no-skip-git-hooks',
  'oa.package-manager',
  'oa.workspace-writes-only',
  'oa.protect-policy',
  'oa.human-only-decisions',
  'oa.secret-scan-writes',
  'oa.destructive-needs-approval',
];

/** A module of the stack, and the reason it is in it. */
export interface SelectedPolicy {
  /** The module that was selected. */
  module: PolicyModule;
  /** Why it was selected. */
  reason: string;
}

/**
 * The high-risk domain a policy id names, when it names one.
 *
 * The id of a high-risk policy is the domain it guards, so the selection
 * reads the domain off the id rather than off a second list that could
 * disagree with it.
 */
function highRiskDomainOf(id: string): string | undefined {
  if (!id.startsWith(HIGH_RISK_PREFIX)) return undefined;
  const domain = id.slice(HIGH_RISK_PREFIX.length);
  return domain.length === 0 ? undefined : domain;
}

/**
 * The stack for a classification, and why each module is in it.
 *
 * A module of the always-on list is in every stack. A module of the
 * baseline list is in every stack. A high-risk module is in the stack when
 * the classification named its domain, and a plugin module is in the stack
 * as well: a downstream project that installed a module asked for it to
 * run.
 */
export function selectPolicies(
  modules: readonly PolicyModule[],
  classification: RequestClassification,
): SelectedPolicy[] {
  const domain = classification.highRiskDomain;
  const selected: SelectedPolicy[] = [];
  for (const module of modules) {
    if (ALWAYS_ON_POLICY_IDS.includes(module.id)) {
      selected.push({ module, reason: 'the guardrail applies to every tool call' });
      continue;
    }
    const highRisk = highRiskDomainOf(module.id);
    if (highRisk !== undefined) {
      if (domain !== undefined && domain === highRisk) {
        selected.push({
          module,
          reason: `the classification named the ${highRisk} domain`,
        });
      }
      continue;
    }
    const reason = BASELINE_POLICY_IDS.includes(module.id)
      ? 'every session gets this policy'
      : 'a plugin brought this policy';
    selected.push({ module, reason });
  }
  return selected;
}
