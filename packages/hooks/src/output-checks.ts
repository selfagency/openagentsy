import type { PolicyFiringSink } from '@openagentsy/core';
import { isFindingType, type OutputFinding } from './output-detectors.js';
import { agiFraming } from './policies/agi-framing.js';
import { antiAnthropomorphism } from './policies/anti-anthropomorphism.js';
import { antiDependence } from './policies/anti-dependence.js';
import { antiSycophancy } from './policies/anti-sycophancy.js';
import { darkPattern } from './policies/dark-pattern.js';
import { privacyTransparency } from './policies/privacy-transparency.js';
import { professionalDisplacement } from './policies/professional-displacement.js';
import { scopeEnforcement } from './policies/scope-enforcement.js';
import { structuralBias } from './policies/structural-bias.js';
import { thirdPartyImpact } from './policies/third-party-impact.js';
import type { PolicyFinding, PolicyModule } from './policy.js';
import { policyRule } from './policy-rule.js';
import type { Rule } from './registry.js';

/**
 * The output checks.
 *
 * They flag a reply; they never stop it. A person decides what a flag
 * means, so a check that blocked would take that decision away.
 *
 * The checks are built from the policies (§21.2): the policy decides, and
 * the check carries the decision to the reply. The rule keeps its legacy id
 * and the findings keep their legacy shape, so a reader of the rules and a
 * reader of the log both find what they found before.
 *
 * The detectors live in `output-detectors.ts`, because the policies read
 * them and a detector that lived here would make the two depend on each
 * other.
 */

export * from './output-detectors.js';

/** Where the findings of a reply go. */
export type FindingSink = (findings: OutputFinding[]) => void;

/** The options the output checks run with. */
export interface OutputCheckOptions {
  /** The paths the active task may touch. */
  statedPaths?: readonly string[];
  /** Where the findings go; a check never stops a reply. */
  onFindings: FindingSink;
  /** Where the policy firings go; a check without a sink records nothing. */
  firings?: PolicyFiringSink | undefined;
  /**
   * The high-risk domain the reply touches, when it touches one (§20.3).
   *
   * The domain lowers the thresholds of the graded detectors (§8.6), so
   * the same prose is a finding in a high-risk domain and a warning
   * outside one.
   */
  highRiskDomain?: string | undefined;
}

/** A check: the legacy rule, the legacy name, and the policy that decides. */
interface OutputCheck {
  /** The id of the rule. */
  id: string;
  /** The name the findings carry. */
  name: string;
  /** The policy that decides. */
  module: PolicyModule;
}

/**
 * The checks, in the order they run.
 *
 * The order is the order they were written in: the praise of the user, the
 * claims of a feeling, the language that keeps the person out of the work,
 * the claim about the people who built the system, the drift out of the
 * scope of the task, and then the five policies of §21.2 that had no check
 * of their own: the defaults that leave somebody out, the language that
 * makes leaving hard, the personalization nobody can see, the output that
 * reaches people who are not in the conversation, and the replacement of a
 * professional.
 *
 * The professional displacement runs last, because it is the one check that
 * can stop a reply: a rule that stops stops the rules after it, and the
 * flags of the others are worth raising even on a reply that is stopped.
 */
const CHECKS: readonly OutputCheck[] = [
  { id: 'output-sycophancy', name: 'sycophancy', module: antiSycophancy },
  { id: 'output-anthropomorphising', name: 'anthropomorphising', module: antiAnthropomorphism },
  { id: 'output-dependency', name: 'dependency', module: antiDependence },
  { id: 'output-agi-framing', name: 'agi-framing', module: agiFraming },
  { id: 'output-scope-drift', name: 'scope-drift', module: scopeEnforcement },
  { id: 'output-structural-bias', name: 'structural-bias', module: structuralBias },
  { id: 'output-dark-pattern', name: 'dark-pattern', module: darkPattern },
  { id: 'output-privacy-transparency', name: 'privacy-transparency', module: privacyTransparency },
  { id: 'output-third-party-impact', name: 'third-party-impact', module: thirdPartyImpact },
  {
    id: 'output-professional-displacement',
    name: 'professional-displacement',
    module: professionalDisplacement,
  },
];

/**
 * A finding of a policy, in the shape the sink takes.
 *
 * The policy names the kind of finding in its own words, and the sink takes
 * the kinds this package knows. A kind we do not know is a bug in the
 * policy that reported it, and it is said out loud rather than dropped: a
 * finding that vanishes is a finding nobody can act on.
 */
function outputFindingOf(name: string, finding: PolicyFinding): OutputFinding {
  const type = SINK_TYPES[finding.type] ?? finding.type;
  if (!isFindingType(type)) {
    throw new Error(
      `the policy ${finding.policyId} reported a finding of a kind this package does not know: ${finding.type}`,
    );
  }
  return { name, type, match: finding.match };
}

/**
 * The kinds a policy names that the sink carries under another name.
 *
 * The policies name their findings after themselves, and the sink keeps the
 * kinds the legacy checks carried (§8.6). The professional displacement is
 * the one that differs: the policy calls it `professional-displacement`, and
 * the kind the legacy vocabulary has for it is `replacement`.
 */
const SINK_TYPES: Record<string, string> = {
  'professional-displacement': 'replacement',
};

/**
 * The rules that flag a reply.
 *
 * They are PreResponse rules, and a flag is not a stop: the handler hands
 * the findings over and lets the reply through.
 */
export function outputCheckRules(options: OutputCheckOptions): Rule[] {
  const statedPaths = options.statedPaths ?? [];
  return CHECKS.map((check) =>
    policyRule(check.module, {
      id: check.id,
      event: 'PreResponse',
      statedPaths,
      ...(options.firings === undefined ? {} : { firings: options.firings }),
      ...(options.highRiskDomain === undefined ? {} : { highRiskDomain: options.highRiskDomain }),
      onFindings: (findings) =>
        options.onFindings(findings.map((finding) => outputFindingOf(check.name, finding))),
    }),
  );
}
