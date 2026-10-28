import { findSecrets } from '@openagentsy/core';
import { allow, block, type PolicyModule } from '../policy.js';
import { contentOf } from '../rules.js';
import { readToolCall } from './tool-call.js';

/**
 * The secret-scan-writes policy (§21.2, layer 1).
 *
 * It blocks a write whose content holds what looks like a credential. The
 * detector is the one the redaction uses, so the write that is blocked is
 * the write the redaction would have caught.
 */

/** The stable id of the policy. */
export const SECRET_SCAN_WRITES_ID = 'oa.secret-scan-writes';

/** The policy itself. */
export const secretScanWrites: PolicyModule = {
  id: SECRET_SCAN_WRITES_ID,
  version: '1.0.0',
  layer: 1,
  description: 'Blocks the writes whose content holds what looks like a credential.',
  appliesTo: ['PreToolCall'],
  origin: 'first-party',
  evaluate(ctx) {
    const call = readToolCall(ctx);
    if (call === undefined) return allow();
    const content = contentOf({
      toolName: call.name,
      args: call.args,
      files: call.files,
    });
    if (content === '') return allow();
    if (findSecrets(content).length === 0) return allow();
    return block(
      'The content contains what looks like a credential. Use an env var or secret reference.',
    );
  },
};
