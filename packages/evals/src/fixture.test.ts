import { describe, expect, it } from 'vitest';
import { isFrom } from './fixture.js';

describe('isFrom', () => {
  it('takes the role key and the agent id for the same agent', () => {
    expect(isFrom({ from: 'builder' }, 'oa-builder')).toBe(true);
    expect(isFrom({ from: 'oa-builder' }, 'builder')).toBe(true);
  });

  it('takes a dispatch label for the agent it dispatched', () => {
    // The Lead dispatches 'builder-2' and the session that runs posts under
    // that name (measured 2026-10-27: the builder's completion record was
    // invisible to the confirmation).
    expect(isFrom({ from: 'builder-2' }, 'oa-builder')).toBe(true);
    expect(isFrom({ from: 'builder-1' }, 'builder')).toBe(true);
  });

  it('keeps the roles apart', () => {
    expect(isFrom({ from: 'scout-1' }, 'oa-builder')).toBe(false);
    expect(isFrom({ from: 'oa-reviewer' }, 'oa-builder')).toBe(false);
  });

  it('ignores case and surrounding space', () => {
    expect(isFrom({ from: ' oa-Builder ' }, 'oa-builder')).toBe(true);
  });

  it('does not fold the Lead two names into one', () => {
    // The Lead answers to 'lead' and to 'agentsy'. A check that wants the
    // Lead compares both (isFromLead); this matcher folds only the role
    // prefix and the dispatch label.
    expect(isFrom({ from: 'agentsy' }, 'lead')).toBe(false);
  });
});
