import { BoardError } from './records.js';
import { DISPATCH_STATUSES, isRoundStatus, type RoundStatus } from './types.js';

/**
 * A delegated item of the Lead's round (§8.7).
 *
 * Every delegated item has an owner — the agent that does the work — and a
 * return condition: what has to come back for the round to move on. A
 * dispatch without either one is a task nobody is answerable for, so the
 * board refuses it.
 */
export type Dispatch = {
  /** The id of the delegated item. */
  id: string;
  /** The agent that does the work. */
  owner: string;
  /** What has to come back for the round to move on. */
  returnCondition: string;
  /** Where the delegated item is. */
  status: RoundStatus;
  /** The bean the item belongs to. */
  bean: string;
};

/**
 * The status of a round, or a refusal that names the valid ones.
 *
 * The message names what was given and the hint names the five statuses, so
 * a caller that gets the refusal can fix the call without reading the plan.
 */
export function assertRoundStatus(value: unknown): RoundStatus {
  if (isRoundStatus(value)) return value;
  throw new BoardError(
    `unknown round status "${String(value)}"`,
    `use one of ${DISPATCH_STATUSES.join(', ')}`,
  );
}

/**
 * Whether a field of a dispatch is missing.
 *
 * A field that is absent arrives as undefined, and one that is empty
 * arrives as a blank string: both are a missing field, and neither is a
 * string the length can be read from.
 */
function missingField(dispatch: Dispatch, field: keyof Dispatch): boolean {
  const value = dispatch[field];
  return typeof value !== 'string' || value.trim().length === 0;
}

/** The field names of a dispatch, and how they read in a sentence. */
const FIELD_LABELS: Record<keyof Dispatch, string> = {
  id: 'id',
  owner: 'owner',
  returnCondition: 'return condition',
  status: 'status',
  bean: 'bean',
};

/**
 * Check a dispatch before it is written to the board.
 *
 * The dispatch returns the dispatch it was given, so the call reads as one
 * line at the call site: `validateDispatch(dispatch)`.
 */
export function validateDispatch(dispatch: Dispatch): Dispatch {
  for (const field of ['id', 'owner', 'returnCondition', 'bean'] as const) {
    if (missingField(dispatch, field)) {
      throw new BoardError(
        `the dispatch has no ${FIELD_LABELS[field]}`,
        'a delegated item needs an id, an owner, a return condition and a bean',
      );
    }
  }
  assertRoundStatus(dispatch.status);
  return dispatch;
}
