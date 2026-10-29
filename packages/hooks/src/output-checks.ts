import type { PolicyFiringSink } from '@openagentsy/core';
import { isFindingType, type OutputFinding } from './output-detectors.js';
import { agiFraming } from './policies/agi-framing.js';
import { antiAnthropomorphism } from './policies/anti-anthropomorphism.js';
import { antiDependence } from './policies/anti-dependence.js';
import { antiSycophancy } from './policies/anti-sycophancy.js';
import { scopeEnforcement } from './policies/scope-enforcement.js';
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
 * The five checks, in the order they run.
 *
 * The order is the order they were written in: the praise of the user, the
 * claims of a feeling, the language that keeps the person out of the work,
 * the claim about the people who built the system, and the drift out of the
 * scope of the task.
 */
const CHECKS: readonly OutputCheck[] = [
  { id: 'output-sycophancy', name: 'sycophancy', module: antiSycophancy },
  { id: 'output-anthropomorphising', name: 'anthropomorphising', module: antiAnthropomorphism },
  { id: 'output-dependency', name: 'dependency', module: antiDependence },
  { id: 'output-agi-framing', name: 'agi-framing', module: agiFraming },
  { id: 'output-scope-drift', name: 'scope-drift', module: scopeEnforcement },
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
  if (!isFindingType(finding.type)) {
    throw new Error(
      `the policy ${finding.policyId} reported a finding of a kind this package does not know: ${finding.type}`,
    );
  }
  return { name, type: finding.type, match: finding.match };
}

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
      onFindings: (findings) =>
        options.onFindings(findings.map((finding) => outputFindingOf(check.name, finding))),
    }),
  );
}
