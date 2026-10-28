import { describe, expect, it } from 'vitest';
import { DISPATCH_STATUSES, isRoundStatus } from './types.js';

describe('the round statuses', () => {
  it('accepts each of the five', () => {
    expect(DISPATCH_STATUSES).toEqual([
      'running',
      'awaiting_result',
      'paused',
      'blocked',
      'complete',
    ]);
    for (const status of DISPATCH_STATUSES) {
      expect(isRoundStatus(status)).toBe(true);
    }
  });

  it('treats awaiting_result as a status and not a failure', () => {
    // A round that waits for a delegated item is working, not stuck. The
    // status list carries it, so a validator cannot refuse it by accident.
    expect(isRoundStatus('awaiting_result')).toBe(true);
    expect(DISPATCH_STATUSES).toContain('awaiting_result');
  });

  it('refuses a status it does not know', () => {
    expect(isRoundStatus('done')).toBe(false);
    expect(isRoundStatus('')).toBe(false);
    expect(isRoundStatus(undefined)).toBe(false);
    expect(isRoundStatus(3)).toBe(false);
  });
});
