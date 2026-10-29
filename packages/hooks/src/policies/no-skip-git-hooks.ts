import { skipsGitHooks } from '../guards.js';
import { allow, block, type PolicyModule } from '../policy.js';
import { readToolCall } from './tool-call.js';

/**
 * The no-skip-git-hooks policy (§21.2, layer 1).
 *
 * It blocks the flags that skip the pre-commit hook: `--no-verify`, its
 * short form `-n`, `HUSKY=0` and a moved `core.hooksPath`. The hook is
 * where the lint and the typecheck run, so a commit that skips it skips the
 * checks too.
 */

/** The stable id of the policy. */
export const NO_SKIP_GIT_HOOKS_ID = 'oa.no-skip-git-hooks';

/** The policy itself. */
export const noSkipGitHooks: PolicyModule = {
  id: NO_SKIP_GIT_HOOKS_ID,
  version: '1.0.0',
  layer: 1,
  description: 'Blocks the flags that skip the git hooks.',
  appliesTo: ['PreToolCall'],
  origin: 'first-party',
  evaluate(ctx) {
    const call = readToolCall(ctx);
    if (call === undefined || call.command === undefined) return allow();
    if (!skipsGitHooks(call.command)) return allow();
    return block('Git hooks (lint, typecheck) cannot be skipped. Fix the reported errors instead.');
  },
};
