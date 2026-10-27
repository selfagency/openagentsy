import type { V1PermissionBlock } from '@openagentsy/core';
import { describe, expect, it } from 'vitest';
import { mergePermissions, permissionEntriesFor } from './permission-merge.js';

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
