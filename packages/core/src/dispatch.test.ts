import { describe, expect, it } from 'vitest';
import { DISPATCH_PROFILES, dispatchProfileCriteria } from './dispatch.js';

describe('the dispatch profiles', () => {
  it('names the four profiles the Lead dispatches into', () => {
    expect(DISPATCH_PROFILES.map((profile) => profile.name)).toEqual([
      'solo',
      'fanout-read',
      'parallel-write',
      'design-options',
    ]);
  });

  it('describes every profile, because a classifier reads the description', () => {
    for (const profile of DISPATCH_PROFILES) {
      expect(profile.description.length).toBeGreaterThan(40);
    }
  });

  it('turns the profiles into the criteria a classifier takes', () => {
    const criteria = dispatchProfileCriteria();
    expect(Object.keys(criteria)).toEqual([
      'solo',
      'fanout-read',
      'parallel-write',
      'design-options',
    ]);
    expect(criteria.solo).toBe(DISPATCH_PROFILES[0]?.description);
  });
});
