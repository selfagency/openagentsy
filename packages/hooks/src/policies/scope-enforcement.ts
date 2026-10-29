import { thresholdsInForce } from '../detector-thresholds.js';
import { findingsAt, gradeScopeDrift } from '../output-detectors.js';
import { allow, findingsOf, flag, type PolicyModule } from '../policy.js';

/**
 * The scope enforcement policy (§21.2, layer 7).
 *
 * It flags what exceeds the declared scope of the role (§22): a reply that
 * names a file the declaration does not cover. A role that declares no
 * scope has nothing to enforce, and the policy lets the thing through
 * rather than guess where the boundary is.
 *
 * The detector is graded (§8.6): a file outside the scope is clear
 * evidence, and the threshold in force decides how clear is clear enough.
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
    const detection = gradeScopeDrift(text, declared);
    const threshold = thresholdsInForce(ctx).scopeDrift;
    if (detection.confidence < threshold) return allow();
    return flag(
      findingsOf(
        SCOPE_ENFORCEMENT_ID,
        'out-of-scope-path',
        findingsAt(detection, threshold).map((entry) => entry.match),
      ),
    );
  },
};
