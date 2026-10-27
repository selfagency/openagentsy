import { redact } from '@openagentsy/core';

/**
 * The redaction every stored thing goes through.
 *
 * The patterns live in core, because the memory slice needed them first
 * and two copies of a secret pattern are two things to keep in step. This
 * is the one door: a board record, a harvested memory candidate, a lesson
 * summary. The count is what the Accountability block shows.
 *
 * The known gap stays where the plan records it: the entropy guard is
 * strictly above 4.0 bits per character, so a pure-hex value of 32
 * characters is never flagged. The helper is core's, and 2f owns the fix.
 */
export function redactForStorage(s: string): { text: string; count: number } {
  return redact(s);
}
