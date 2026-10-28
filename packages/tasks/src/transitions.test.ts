import { describe, expect, it } from 'vitest';
import { STATUSES, type Status, type Task } from './model.js';
import {
  enforceContentRules,
  enforceQualityRules,
  enforceStatusTransition,
  findCycle,
  InvalidStatusTransitionError,
  VALID_TRANSITIONS,
} from './transitions.js';

/**
 * The rules the code enforces, so the prompts do not have to.
 *
 * The whitelist is checked from both sides: every move it names has to
 * work, and every move it does not name has to be refused. A rule that only
 * refuses is a rule nobody trusts.
 */
const task = (over: Partial<Task> = {}): Task => ({
  id: 't',
  slug: 't',
  path: 't.md',
  title: 'A task',
  status: 'todo',
  body: '',
  etag: 'e',
  ...over,
});

describe('the status transitions', () => {
  it('allows every move the whitelist names', () => {
    for (const from of STATUSES) {
      for (const to of VALID_TRANSITIONS[from]) {
        expect(() =>
          enforceStatusTransition(task({ status: from }), task({ status: to })),
        ).not.toThrow();
      }
    }
  });

  it('refuses every move the whitelist does not name', () => {
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        if (to === from) continue;
        if (VALID_TRANSITIONS[from].includes(to)) continue;
        expect(() => enforceStatusTransition(task({ status: from }), task({ status: to }))).toThrow(
          InvalidStatusTransitionError,
        );
      }
    }
  });

  it('leaves a task that keeps its status alone', () => {
    for (const status of STATUSES) {
      expect(() => enforceStatusTransition(task({ status }), task({ status }))).not.toThrow();
    }
  });

  it('refuses a finished task that would be started again', () => {
    expect(() =>
      enforceStatusTransition(task({ status: 'completed' }), task({ status: 'todo' })),
    ).toThrow(InvalidStatusTransitionError);
  });

  it('refuses a task that would be unscrapped', () => {
    expect(() =>
      enforceStatusTransition(task({ status: 'scrapped' }), task({ status: 'todo' })),
    ).toThrow(InvalidStatusTransitionError);
  });
});

describe('the content rules', () => {
  it('wants the items of a completed task checked off', () => {
    expect(() =>
      enforceContentRules(task({ status: 'completed', body: '- [ ] still to do' })),
    ).toThrow(/Unchecked items/);
  });

  it('wants a summary of the changes', () => {
    expect(() => enforceContentRules(task({ status: 'completed', body: 'all done' }))).toThrow(
      /Summary of Changes/,
    );
  });

  it('accepts a completed task that says what changed', () => {
    expect(() =>
      enforceContentRules(
        task({ status: 'completed', body: '- [x] done\n\n## Summary of Changes\n\nIt works.' }),
      ),
    ).not.toThrow();
  });

  it('wants the reasons a task was scrapped', () => {
    expect(() => enforceContentRules(task({ status: 'scrapped', body: 'not needed' }))).toThrow(
      /Reasons for Scrapping/,
    );
    expect(() =>
      enforceContentRules(task({ status: 'scrapped', body: '## Reasons for Scrapping\n\nDupe.' })),
    ).not.toThrow();
  });

  it('keeps an epic a container', () => {
    expect(() => enforceContentRules(task({ type: 'epic', status: 'in-progress' }))).toThrow(
      /Epics are containers/,
    );
  });

  it('wants a tag it can read', () => {
    expect(() => enforceContentRules(task({ tags: ['Not A Tag'] }))).toThrow(/Invalid tag/);
    expect(() => enforceContentRules(task({ tags: ['not-a-tag'] }))).not.toThrow();
  });
});

describe('the dependency cycles', () => {
  it('finds a cycle through the parents', () => {
    const cycle = findCycle([task({ id: 'a', parent: 'b' }), task({ id: 'b', parent: 'a' })]);
    expect(cycle).toBeDefined();
    expect(new Set(cycle)).toEqual(new Set(['a', 'b']));
    expect(cycle?.[0]).toBe(cycle?.[cycle.length - 1]);
  });

  it('finds a cycle through the blockers', () => {
    const cycle = findCycle([
      task({ id: 'a', blocked_by: ['b'] }),
      task({ id: 'b', blocked_by: ['a'] }),
    ]);
    expect(new Set(cycle)).toEqual(new Set(['a', 'b']));
  });

  it('finds a cycle through the tasks that block', () => {
    const cycle = findCycle([
      task({ id: 'a', blocking: ['b'] }),
      task({ id: 'b', blocking: ['a'] }),
    ]);
    expect(new Set(cycle)).toEqual(new Set(['a', 'b']));
  });

  it('finds a cycle of three', () => {
    const cycle = findCycle([
      task({ id: 'a', parent: 'b' }),
      task({ id: 'b', parent: 'c' }),
      task({ id: 'c', parent: 'a' }),
    ]);
    expect(cycle).toBeDefined();
    expect(cycle?.length).toBe(4);
    expect(new Set(cycle)).toEqual(new Set(['a', 'b', 'c']));
  });

  it('finds no cycle in a tree', () => {
    expect(
      findCycle([
        task({ id: 'a', parent: 'b' }),
        task({ id: 'b', parent: 'c' }),
        task({ id: 'c' }),
      ]),
    ).toBeUndefined();
  });

  it('ignores a relation to a task that is not there', () => {
    expect(findCycle([task({ id: 'a', parent: 'nowhere' })])).toBeUndefined();
  });
});

describe('the floor findings of a task', () => {
  const finding = {
    ruleId: 'copy/unsourced-claim',
    file: 'src/page.html',
    line: 4,
    message: 'The copy makes a claim with no source.',
    fix: 'Cite where the claim comes from',
  };

  it('refuses a task that is completed with an open floor finding', async () => {
    await expect(
      enforceQualityRules(task({ status: 'completed' }), { openFloorFindings: () => [finding] }),
    ).rejects.toThrow(/open floor quality finding/);
  });

  it('lets a task be completed when no floor finding is open', async () => {
    await expect(
      enforceQualityRules(task({ status: 'completed' }), { openFloorFindings: () => [] }),
    ).resolves.toBeUndefined();
  });

  it('leaves a task that is not completed alone', async () => {
    await expect(
      enforceQualityRules(task({ status: 'in-progress' }), { openFloorFindings: () => [finding] }),
    ).resolves.toBeUndefined();
  });

  it('enforces nothing when the reader is not injected', async () => {
    await expect(enforceQualityRules(task({ status: 'completed' }), {})).resolves.toBeUndefined();
  });
});

/** The status a move names, for the error message. */
export const moveTo = (status: Status): Status => status;
