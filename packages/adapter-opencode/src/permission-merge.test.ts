import type { PermissionEffect, V1PermissionBlock } from '@openagentsy/core';
import { describe, expect, it } from 'vitest';
import { mergePermissions, permissionEntriesFor } from './permission-merge.js';

/**
 * Whether a pattern matches a command.
 *
 * The oracle is written here and not taken from the module under test: a
 * matcher that is wrong in the same way as the code it checks hides the
 * mistake, and the host's own matching is what a permission map is read
 * with. An OpenCode permission pattern is a wildcard where a single
 * asterisk matches zero or more of any character.
 */
function patternMatches(pattern: string, command: string): boolean {
  const parts = pattern.split('*');
  if (parts.length === 1) return pattern === command;
  const head = parts[0] ?? '';
  const tail = parts[parts.length - 1] ?? '';
  if (!command.startsWith(head)) return false;
  if (!command.endsWith(tail)) return false;
  return command.length >= head.length + tail.length;
}

/**
 * The effect a command gets from a permission map.
 *
 * OpenCode takes the last matching rule, so the map is walked in order and
 * the last rule that matches is the one that decides.
 */
function effective(block: Record<string, PermissionEffect>, command: string): PermissionEffect {
  let effect: PermissionEffect = 'allow';
  for (const [pattern, value] of Object.entries(block)) {
    if (patternMatches(pattern, command)) effect = value;
  }
  return effect;
}

describe('mergePermissions', () => {
  it('turns an allow into an ask', () => {
    const current: V1PermissionBlock = { bash: { 'git push*': 'allow' } };
    const incoming: V1PermissionBlock = { bash: { 'git push*': 'ask' } };
    const merged = mergePermissions(current, incoming);
    expect(merged['bash']).toEqual({ 'git push*': 'ask' });
  });

  it('turns an ask into a deny', () => {
    const current: V1PermissionBlock = { bash: { 'git push*': 'ask' } };
    const incoming: V1PermissionBlock = { bash: { 'git push*': 'deny' } };
    const merged = mergePermissions(current, incoming);
    expect(merged['bash']).toEqual({ 'git push*': 'deny' });
  });

  it('refuses to turn a deny into an allow', () => {
    const current: V1PermissionBlock = { bash: { 'git push*': 'deny' } };
    const incoming: V1PermissionBlock = { bash: { 'git push*': 'allow' } };
    expect(() => mergePermissions(current, incoming)).toThrow(/loosen/);
  });

  it('refuses to turn an ask into an allow', () => {
    const current: V1PermissionBlock = { bash: { 'git push*': 'ask' } };
    const incoming: V1PermissionBlock = { bash: { 'git push*': 'allow' } };
    expect(() => mergePermissions(current, incoming)).toThrow(/loosen/);
  });

  it('keeps a deny a deny', () => {
    const current: V1PermissionBlock = { bash: { 'git push*': 'deny' } };
    const incoming: V1PermissionBlock = { bash: { 'git push*': 'deny' } };
    const merged = mergePermissions(current, incoming);
    expect(merged['bash']).toEqual({ 'git push*': 'deny' });
  });

  it('leaves the config it was given alone', () => {
    const current: V1PermissionBlock = { bash: { 'git push*': 'allow' } };
    const incoming: V1PermissionBlock = { bash: { 'git push*': 'ask' } };
    mergePermissions(current, incoming);
    expect(current['bash']).toEqual({ 'git push*': 'allow' });
  });

  it('asks about a command nobody had a rule for', () => {
    // A pattern that is not named takes the catch-all, and a catch-all
    // that is not named is the most permissive effect.
    const current: V1PermissionBlock = { bash: 'allow' };
    const incoming: V1PermissionBlock = { bash: { 'git push*': 'ask' } };
    const merged = mergePermissions(current, incoming);
    expect(merged['bash']).toEqual({ '*': 'allow', 'git push*': 'ask' });
  });

  it('keeps the shorthand a shorthand', () => {
    const current: V1PermissionBlock = { bash: 'allow' };
    const incoming: V1PermissionBlock = { bash: 'ask' };
    const merged = mergePermissions(current, incoming);
    expect(merged['bash']).toBe('ask');
  });

  it('adds a rule to an action that has none', () => {
    const incoming: V1PermissionBlock = { bash: { 'git push*': 'ask' } };
    const merged = mergePermissions({}, incoming);
    expect(merged['bash']).toEqual({ 'git push*': 'ask' });
  });

  it('keeps a narrower deny ahead of a broader ask', () => {
    // The broad key would land last and take the narrow one's place, because
    // OpenCode takes the last matching rule. The deny has to stay last.
    const current: V1PermissionBlock = { bash: { 'git push --force': 'deny' } };
    const incoming: V1PermissionBlock = { bash: { 'git push*': 'ask' } };
    const merged = mergePermissions(current, incoming);

    const bash = merged['bash'] as Record<string, PermissionEffect>;
    expect(Object.keys(bash)).toEqual(['git push*', 'git push --force']);
    expect(effective(bash, 'git push --force')).toBe('deny');
    expect(effective(bash, 'git push origin main')).toBe('ask');
  });

  it('tightens a broad allow with a narrow deny', () => {
    const current: V1PermissionBlock = { bash: { 'git push*': 'allow' } };
    const incoming: V1PermissionBlock = { bash: { 'git push --force': 'deny' } };
    const merged = mergePermissions(current, incoming);

    const bash = merged['bash'] as Record<string, PermissionEffect>;
    expect(effective(bash, 'git push --force')).toBe('deny');
    expect(effective(bash, 'git push origin main')).toBe('allow');
  });

  it('keeps a deny that a catch-all would have buried', () => {
    // The deny is written first and the catch-all last, so the deny is
    // already buried. The merge cannot place the ask without burying it
    // further, so the merge is refused.
    const current: V1PermissionBlock = {
      bash: { 'git push --force': 'deny', '*': 'allow' },
    };
    const incoming: V1PermissionBlock = { bash: { 'git push*': 'ask' } };
    expect(() => mergePermissions(current, incoming)).toThrow(/loosen/);
  });

  it('refuses to loosen a deny that shares the pattern', () => {
    const current: V1PermissionBlock = { bash: { 'git push*': 'deny' } };
    const incoming: V1PermissionBlock = { bash: { 'git push*': 'ask' } };
    expect(() => mergePermissions(current, incoming)).toThrow(/loosen/);
  });

  it('places a rule that is written again', () => {
    // The rule was placed when it first arrived, and the rules around it
    // have moved since, so a rule that now overlaps a looser rule after it
    // would stay buried there.
    const current: V1PermissionBlock = { bash: { 'git push --force': 'ask', '*': 'allow' } };
    const incoming: V1PermissionBlock = { bash: { 'git push --force': 'deny' } };
    const merged = mergePermissions(current, incoming);

    const bash = merged['bash'] as Record<string, PermissionEffect>;
    expect(effective(bash, 'git push --force')).toBe('deny');
  });

  it('places an approval ask that is written again', () => {
    const current: V1PermissionBlock = { bash: { 'git push*': 'ask', '*': 'allow' } };
    const incoming: V1PermissionBlock = { bash: { 'git push*': 'ask' } };
    const merged = mergePermissions(current, incoming);

    const bash = merged['bash'] as Record<string, PermissionEffect>;
    expect(effective(bash, 'git push origin main')).toBe('ask');
    expect(effective(bash, 'ls -la')).toBe('allow');
  });
});

describe('permissionEntriesFor', () => {
  it('asks about every command of the list', () => {
    expect(permissionEntriesFor(['git push', 'gh pr merge'])).toEqual({
      bash: { 'git push*': 'ask', 'gh pr merge*': 'ask' },
    });
  });

  it('asks for nothing when the list is empty', () => {
    expect(permissionEntriesFor([])).toEqual({});
    expect(permissionEntriesFor(['  '])).toEqual({});
  });
});
