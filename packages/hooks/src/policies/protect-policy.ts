import { isReaderTool } from '../event.js';
import { isProtected, shellViolation } from '../guards.js';
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

/**
 * The reason a refused write carries.
 *
 * The rule and the policy refuse the same thing, so the reason lives here
 * and the legacy rule reads it: two layers that say different things about
 * one refusal are two answers to one question.
 */
export const PROTECT_REASON =
  'Policy, role, permission, build-config, lockfile, hook, workflow, lesson and waiver files are changed by a person (or, for bun.lock, by `bun add`; for roles.yaml and templates, by running the generator). Propose the change in chat.';

/**
 * The reason a blind write is refused with.
 *
 * The command can write any file and names no path for, so the guard
 * cannot show that it is safe. Naming the paths is what makes the command
 * checkable, and the files a person changes are not written by an agent.
 */
export function blindWriteReason(command: string): string {
  return `\`${command}\` can write any file and names no target, so the guard cannot show that it is safe. Name the paths it writes. The policy, role, permission, build-config, lockfile, hook, workflow, lesson and waiver files are changed by a person. Propose the change in chat.`;
}

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
    if (isReaderTool(call.name)) return allow();
    // The shell writes files too, and the file tool's paths do not name
    // them: the write targets of the command are read here.
    if (call.command !== undefined) {
      const violation = shellViolation(call.command);
      if (violation !== undefined) {
        if (violation.kind === 'blind') return block(blindWriteReason(violation.command));
        return block(PROTECT_REASON);
      }
    }
    if (!writesFiles(call)) return allow();
    const touched = call.files.some(
      (file) =>
        (file.path !== undefined && isProtected(file.path)) ||
        (file.fromPath !== undefined && isProtected(file.fromPath)),
    );
    if (!touched) return allow();
    return block(PROTECT_REASON);
  },
};
