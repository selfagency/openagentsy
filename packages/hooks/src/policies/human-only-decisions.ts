import { allow, block, type PolicyModule } from '../policy.js';
import { readToolCall } from './tool-call.js';

/**
 * The human-only decisions policy (§21.2, layer 1).
 *
 * It blocks the calls that record a decision a person makes: a lesson
 * decision, a quality waiver and a memory promotion. The permission map
 * denies those tools to every agent role, and this policy is the second
 * layer of the same guarantee.
 */

/** The stable id of the policy. */
export const HUMAN_ONLY_DECISIONS_ID = 'oa.human-only-decisions';

/** The tools a person decides with. */
const HUMAN_ONLY_TOOLS = ['oa_lesson_decide', 'oa_quality_waive', 'oa_memory_decide'];

/** The policy itself. */
export const humanOnlyDecisions: PolicyModule = {
  id: HUMAN_ONLY_DECISIONS_ID,
  version: '1.0.0',
  layer: 1,
  description: 'Blocks the calls that record a decision a person makes.',
  appliesTo: ['PreToolCall'],
  origin: 'first-party',
  evaluate(ctx) {
    const call = readToolCall(ctx);
    if (call === undefined) return allow();
    const humanOnly = HUMAN_ONLY_TOOLS.some(
      (name) => call.name === name || call.name.endsWith(`_${name}`),
    );
    if (!humanOnly) return allow();
    return block(
      'Lesson decisions, quality waivers and memory promotions are recorded by a person (/oa lesson, /oa waive, /oa memory). Propose it in chat with your evidence.',
    );
  },
};
