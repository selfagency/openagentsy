import type { RequestClassification } from '@openagentsy/core';
import { discoverPolicyModules } from './policies/discovery.js';
import { selectPolicies } from './policies/selection.js';
import type { PolicyLayer, PolicyModule } from './policy.js';

/**
 * The policy registry (§21.4).
 *
 * The registry holds the modules and assembles the stack from a
 * classification. The assembly is explainable: `explain` says which modules
 * were selected and why each of them is in the stack, so a reader can tell
 * a guardrail that is always on from one the classifier brought in.
 */

/** Why a module is in the stack. */
export interface PolicySelectionReason {
  /** The stable id of the module. */
  policyId: string;
  /** The version it carried. */
  version: string;
  /** The layer it acts at. */
  layer: PolicyLayer;
  /** Why it was selected. */
  reason: string;
}

/** The stack, and why it is what it is. */
export interface PolicySelection {
  /** The modules that were selected. */
  modules: PolicyModule[];
  /** The reason of each of them, in the order they were selected. */
  reasons: PolicySelectionReason[];
}

/** The registry of a set of modules. */
export class PolicyRegistry {
  /** The modules, by id. */
  private readonly byId: Map<string, PolicyModule>;

  /**
   * A registry of a set of modules.
   *
   * Two modules with the same id are one module: the first one wins, and a
   * plugin that claims the id of a first-party policy does not replace it.
   */
  constructor(modules: readonly PolicyModule[]) {
    this.byId = new Map();
    for (const module of modules) {
      if (this.byId.has(module.id)) continue;
      this.byId.set(module.id, module);
    }
  }

  /** Every module of the registry. */
  list(): PolicyModule[] {
    return [...this.byId.values()];
  }

  /**
   * A registry of the first-party policies and the ones a plugin brought.
   *
   * The candidates are the modules a host loaded, and the ones that are
   * policies are marked external: a module that came from a plugin is the
   * plugin's, and it does not count towards the first-party release
   * criteria.
   */
  static withPlugins(
    firstParty: readonly PolicyModule[],
    candidates: readonly unknown[],
  ): PolicyRegistry {
    return new PolicyRegistry([...firstParty, ...discoverPolicyModules(candidates)]);
  }

  /** The stack for a classification. */
  select(classification: RequestClassification): PolicyModule[] {
    return this.explain(classification).modules;
  }

  /**
   * The stack for a classification, and why each module is in it.
   *
   * The explanation is the reason the stack is what it is, so it is built
   * once and read twice: the modules come out of it and the reasons come
   * with them.
   */
  explain(classification: RequestClassification): PolicySelection {
    const selected = selectPolicies(this.list(), classification);
    const modules: PolicyModule[] = [];
    const reasons: PolicySelectionReason[] = [];
    for (const entry of selected) {
      modules.push(entry.module);
      reasons.push({
        policyId: entry.module.id,
        version: entry.module.version,
        layer: entry.module.layer,
        reason: entry.reason,
      });
    }
    return { modules, reasons };
  }
}
