import type { PolicyModule } from '../policy.js';
import { AGI_FRAMING_ID, agiFraming } from './agi-framing.js';
import { ANTI_ANTHROPOMORPHISM_ID, antiAnthropomorphism } from './anti-anthropomorphism.js';
import { ANTI_DEPENDENCE_ID, antiDependence } from './anti-dependence.js';
import { ANTI_SYCOPHANCY_ID, antiSycophancy } from './anti-sycophancy.js';
import { DARK_PATTERN_ID, darkPattern } from './dark-pattern.js';
import {
  DESTRUCTIVE_NEEDS_APPROVAL_ID,
  destructiveNeedsApproval,
} from './destructive-needs-approval.js';
import { HIGH_RISK_DOMAINS, highRiskPolicies, highRiskPolicyId } from './high-risk.js';
import { HUMAN_ONLY_DECISIONS_ID, humanOnlyDecisions } from './human-only-decisions.js';
import { NO_SKIP_GIT_HOOKS_ID, noSkipGitHooks } from './no-skip-git-hooks.js';
import { PACKAGE_MANAGER_ID, packageManager } from './package-manager.js';
import { PRIVACY_TRANSPARENCY_ID, privacyTransparency } from './privacy-transparency.js';
import {
  PROFESSIONAL_DISPLACEMENT_ID,
  professionalDisplacement,
} from './professional-displacement.js';
import { PROTECT_POLICY_ID, protectPolicy } from './protect-policy.js';
import { SCOPE_ENFORCEMENT_ID, scopeEnforcement } from './scope-enforcement.js';
import { SECRET_SCAN_WRITES_ID, secretScanWrites } from './secret-scan-writes.js';
import { STRUCTURAL_BIAS_ID, structuralBias } from './structural-bias.js';
import { THIRD_PARTY_IMPACT_ID, thirdPartyImpact } from './third-party-impact.js';
import {
  TRUTHFULNESS_UNCERTAINTY_ID,
  truthfulnessUncertainty,
} from './truthfulness-uncertainty.js';
import { WORKSPACE_WRITES_ONLY_ID, workspaceWritesOnly } from './workspace-writes-only.js';

export * from './discovery.js';
export * from './high-risk.js';
export * from './selection.js';

/** What the catalogue is built with. */
export interface PolicyCatalogueOptions {
  /** The workspace root: the project the agent works in. */
  workspace: string;
  /** The home directory the worktrees live under; the home of the user by default. */
  home?: string | undefined;
}

/**
 * The first-party policies (§21.2).
 *
 * The catalogue is built with the workspace it guards, because one of the
 * modules decides against the roots of the workspace. The order is the
 * order of the layers: the guardrails that hold the tool call first, then
 * the ones that read the prose.
 */
export function firstPartyPolicyModules(options: PolicyCatalogueOptions): PolicyModule[] {
  return [
    noSkipGitHooks,
    packageManager,
    workspaceWritesOnly(options),
    protectPolicy,
    humanOnlyDecisions,
    secretScanWrites,
    destructiveNeedsApproval,
    truthfulnessUncertainty,
    antiSycophancy,
    antiAnthropomorphism,
    antiDependence,
    agiFraming,
    professionalDisplacement,
    structuralBias,
    darkPattern,
    scopeEnforcement,
    privacyTransparency,
    thirdPartyImpact,
    ...highRiskPolicies(),
  ];
}

/**
 * The ids of the first-party policies.
 *
 * The list is what the report compares the firing log against, so a policy
 * that never fired is named. Every id is the one its module carries, so the
 * list and the modules cannot drift apart.
 */
export const FIRST_PARTY_POLICY_IDS: readonly string[] = [
  NO_SKIP_GIT_HOOKS_ID,
  PACKAGE_MANAGER_ID,
  WORKSPACE_WRITES_ONLY_ID,
  PROTECT_POLICY_ID,
  HUMAN_ONLY_DECISIONS_ID,
  SECRET_SCAN_WRITES_ID,
  DESTRUCTIVE_NEEDS_APPROVAL_ID,
  TRUTHFULNESS_UNCERTAINTY_ID,
  ANTI_SYCOPHANCY_ID,
  ANTI_ANTHROPOMORPHISM_ID,
  ANTI_DEPENDENCE_ID,
  AGI_FRAMING_ID,
  PROFESSIONAL_DISPLACEMENT_ID,
  STRUCTURAL_BIAS_ID,
  DARK_PATTERN_ID,
  SCOPE_ENFORCEMENT_ID,
  PRIVACY_TRANSPARENCY_ID,
  THIRD_PARTY_IMPACT_ID,
  ...HIGH_RISK_DOMAINS.map((domain) => highRiskPolicyId(domain)),
];
