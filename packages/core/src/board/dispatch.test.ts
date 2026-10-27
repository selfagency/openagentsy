import { describe, expect, it } from 'vitest';
import { assertRoundStatus, type Dispatch, validateDispatch } from './dispatch.js';
import { BoardError } from './records.js';

function dispatch(overrides: Partial<Dispatch> = {}): Dispatch {
  return {
    id: 'd-1',
    owner: 'oa-builder',
    returnCondition: 'the commit hash and the gate output',
    status: 'running',
    bean: '2c-4',
    ...overrides,
  };
}

describe('the round status', () => {
  it('accepts each of the five', () => {
    for (const status of ['running', 'awaiting_result', 'paused', 'blocked', 'complete'] as const) {
      expect(assertRoundStatus(status)).toBe(status);
    }
  });

  it('names the valid ones when it refuses a status it does not know', () => {
    let refused: BoardError | undefined;
    try {
      assertRoundStatus('finished');
    } catch (error) {
      refused = error as BoardError;
    }
    expect(refused).toBeInstanceOf(BoardError);
    expect(refused?.message).toContain('finished');
    expect(refused?.hint).toContain('awaiting_result');
    expect(refused?.hint).toContain('complete');
  });
});

describe('the dispatch', () => {
  it('accepts a dispatch with an owner and a return condition', () => {
    const given = dispatch();
    const accepted = validateDispatch(given);
    expect(accepted).toEqual(given);
    expect(accepted.owner).toBe('oa-builder');
    expect(accepted.returnCondition).toBe('the commit hash and the gate output');
  });

  it('refuses a dispatch whose owner is not a string at all', () => {
    // The MCP's schema takes the field as optional, so an omitted field
    // arrives as undefined and a null one arrives as null. Both are a
    // missing field, and the refusal has to be a BoardError: the MCP knows
    // how to report one and nothing else.
    const shapes = [
      { ...dispatch(), owner: undefined },
      { ...dispatch(), owner: null },
      { ...dispatch(), owner: '' },
    ];
    for (const shape of shapes) {
      const withoutOwner = shape as unknown as Dispatch;
      let refused: BoardError | undefined;
      try {
        validateDispatch(withoutOwner);
      } catch (error) {
        refused = error as BoardError;
      }
      expect(refused).toBeInstanceOf(BoardError);
      expect(refused?.message).toContain('no owner');
      expect(refused?.hint).toContain('owner');
    }
  });

  it('refuses a dispatch whose return condition is not a string at all', () => {
    const withoutReturn = {
      ...dispatch(),
      returnCondition: undefined,
    } as unknown as Dispatch;
    expect(() => validateDispatch(withoutReturn)).toThrow(BoardError);
    expect(() => validateDispatch(withoutReturn)).toThrow(/no return condition/);
  });

  it('refuses a dispatch without an owner', () => {
    expect(() => validateDispatch(dispatch({ owner: '  ' }))).toThrow(BoardError);
    expect(() => validateDispatch(dispatch({ owner: '' }))).toThrow(/no owner/);
  });

  it('refuses a dispatch without a return condition', () => {
    expect(() => validateDispatch(dispatch({ returnCondition: '' }))).toThrow(
      /no return condition/,
    );
  });

  it('refuses a dispatch whose status it does not know', () => {
    expect(() => validateDispatch(dispatch({ status: 'finished' as Dispatch['status'] }))).toThrow(
      /unknown round status/,
    );
  });

  it('refuses a dispatch that names no id and no bean', () => {
    expect(() => validateDispatch(dispatch({ id: '' }))).toThrow(/no id/);
    expect(() => validateDispatch(dispatch({ bean: '' }))).toThrow(/no bean/);
  });
});
