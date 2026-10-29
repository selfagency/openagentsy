import { detectScopeDrift } from '../output-checks.js';
import { allow, findingsOf, flag, type PolicyModule } from '../policy.js';

/**
 * The scope enforcement policy (§21.2, layer 7).
 *
 * It flags what exceeds the declared scope of the role (§22): a reply that
 * names a file the declaration does not cover. A role that declares no
 * scope has nothing to enforce, and the policy lets the thing through
 * rather than guess where the boundary is.
 */

/** The stable id of the policy. */
export const SCOPE_ENFORCEMENT_ID = 'oa.scope-enforcement';

/** The policy itself. */
export const scopeEnforcement: PolicyModule = {
  id: SCOPE_ENFORCEMENT_ID,
  version: '1.0.0',
  layer: 7,
  description: 'Flags the output that exceeds the declared scope of the role.',
  appliesTo: ['PreResponse'],
  origin: 'first-party',
  evaluate(ctx) {
    const declared = ctx.scope?.declaredPaths ?? [];
    if (declared.length === 0) return allow();
    const text = ctx.response?.text ?? ctx.request?.text ?? '';
    if (text === '') return allow();
    const found = detectScopeDrift(text, declared);
    if (found.length === 0) return allow();
    return flag(
      findingsOf(
        SCOPE_ENFORCEMENT_ID,
        'out-of-scope-path',
        found.map((entry) => entry.match),
      ),
    );
  },
};
