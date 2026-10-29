import { usesOtherPackageManager } from '../guards.js';
import { allow, block, type PolicyModule } from '../policy.js';
import { readToolCall } from './tool-call.js';

/**
 * The package manager policy (§21.2, layer 1).
 *
 * It blocks the other package managers: a second lockfile is a second
 * answer to what the project depends on, and the two disagree.
 */

/** The stable id of the policy. */
export const PACKAGE_MANAGER_ID = 'oa.package-manager';

/** The policy itself. */
export const packageManager: PolicyModule = {
  id: PACKAGE_MANAGER_ID,
  version: '1.0.0',
  layer: 1,
  description: 'Blocks the package managers that are not the one this repo uses.',
  appliesTo: ['PreToolCall'],
  origin: 'first-party',
  evaluate(ctx) {
    const call = readToolCall(ctx);
    if (call === undefined || call.command === undefined) return allow();
    if (!usesOtherPackageManager(call.command)) return allow();
    return block(
      'This repo uses Bun. Use `bun add` / `bun remove` / `bunx`, or `turbo run <task>`.',
    );
  },
};
