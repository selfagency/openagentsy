import { allow, block, type PolicyModule } from '../policy.js';
import { isDestructiveCommand } from '../rules.js';
import { readToolCall } from './tool-call.js';

/**
 * The destructive-needs-approval policy (§21.2, layer 1).
 *
 * It blocks the command that destroys something and leaves the decision to
 * a person: the call is held, and the person approves it once with
 * `/oa approve`. The hook rule of the same name runs the approval gate; the
 * policy is the decision the rule carries.
 */

/** The stable id of the policy. */
export const DESTRUCTIVE_NEEDS_APPROVAL_ID = 'oa.destructive-needs-approval';

/** The policy itself. */
export const destructiveNeedsApproval: PolicyModule = {
  id: DESTRUCTIVE_NEEDS_APPROVAL_ID,
  version: '1.0.0',
  layer: 1,
  description: 'Blocks the destructive commands until a person approves them.',
  appliesTo: ['PreToolCall'],
  origin: 'first-party',
  evaluate(ctx) {
    const call = readToolCall(ctx);
    if (call === undefined || call.command === undefined) return allow();
    if (!isDestructiveCommand(call.command)) return allow();
    return block(
      'This command destroys something. A person approves it once with `/oa approve <callID>`.',
    );
  },
};
