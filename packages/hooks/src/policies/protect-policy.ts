import { isProtected } from '../guards.js';
import { allow, block, type PolicyModule } from '../policy.js';
import { readToolCall, writesFiles } from './tool-call.js';

/**
 * The protect-policy policy (§21.2, layer 1).
 *
 * It blocks a write to the files a person changes: the roles file, the
 * generated agent files, the templates, the workflows, the lockfile and the
 * state that records a decision. The rule is the second layer of the
 * protection; the permission map is the first.
 */

/** The stable id of the policy. */
export const PROTECT_POLICY_ID = 'oa.protect-policy';

/** The policy itself. */
export const protectPolicy: PolicyModule = {
  id: PROTECT_POLICY_ID,
  version: '1.0.0',
  layer: 1,
  description: 'Blocks the writes to the files a person changes.',
  appliesTo: ['PreToolCall'],
  origin: 'first-party',
  evaluate(ctx) {
    const call = readToolCall(ctx);
    if (call === undefined) return allow();
    if (!writesFiles(call)) return allow();
    const touched = call.files.some(
      (file) =>
        (file.path !== undefined && isProtected(file.path)) ||
        (file.fromPath !== undefined && isProtected(file.fromPath)),
    );
    if (!touched) return allow();
    return block(
      'Policy, role, permission, build-config, lockfile, hook, workflow, lesson and waiver files are changed by a person (or, for bun.lock, by `bun add`; for roles.yaml and templates, by running the generator). Propose the change in chat.',
    );
  },
};
