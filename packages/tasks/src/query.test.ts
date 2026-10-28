import { describe, expect, it } from 'vitest';
import type { Task } from './model.js';
import { next, ready } from './query.js';

/**
 * The questions the store is asked about the tasks.
 *
 * The fixtures below are the cases that decide what an agent picks up: a
 * task whose parent is blocked, a task whose parent is finished, a task
 * that is only a container, and a task somebody put down on purpose.
 */
const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  slug: id,
  path: `${id}.md`,
  title: id,
  status: 'todo',
  body: '',
  etag: 'e',
  ...over,
});

/** One fixture: a set of tasks and the ones that are ready. */
interface Fixture {
  name: string;
  tasks: Task[];
  ready: string[];
}

const fixtures: Fixture[] = [
  {
    name: 'a plain todo is ready',
    tasks: [task('a')],
    ready: ['a'],
  },
  {
    name: 'a task held up by a live task is not ready',
    tasks: [task('a', { blocked_by: ['b'] }), task('b', { status: 'in-progress' })],
    ready: [],
  },
  {
    name: 'a task held up by a finished task is ready',
    tasks: [task('a', { blocked_by: ['b'] }), task('b', { status: 'completed' })],
    ready: ['a'],
  },
  {
    name: 'a task under a blocked parent is not ready',
    tasks: [
      task('a', { parent: 'p' }),
      task('p', { blocked_by: ['b'] }),
      task('b', { status: 'in-progress' }),
    ],
    ready: [],
  },
  {
    name: 'a task under a finished parent is not ready',
    tasks: [task('a', { parent: 'p' }), task('p', { status: 'completed' })],
    ready: [],
  },
  {
    name: 'a task under a live parent is ready',
    tasks: [task('a', { parent: 'p' }), task('p', { status: 'in-progress' })],
    ready: ['a'],
  },
  {
    name: 'an epic is a container, not a piece of work',
    tasks: [task('a', { type: 'epic' })],
    ready: [],
  },
  {
    name: 'a milestone is a container, not a piece of work',
    tasks: [task('a', { type: 'milestone' })],
    ready: [],
  },
  {
    name: 'a paused task is not ready',
    tasks: [task('a', { status: 'paused' })],
    ready: [],
  },
  {
    name: 'a task in progress is not ready',
    tasks: [task('a', { status: 'in-progress' })],
    ready: [],
  },
  {
    name: 'a draft is not ready',
    tasks: [task('a', { status: 'draft' })],
    ready: [],
  },
  {
    name: 'a completed task is not ready',
    tasks: [task('a', { status: 'completed' })],
    ready: [],
  },
  {
    name: 'a scrapped task is not ready',
    tasks: [task('a', { status: 'scrapped' })],
    ready: [],
  },
  {
    name: 'a task held up through a chain is not ready',
    tasks: [
      task('a', { blocked_by: ['b'] }),
      task('b', { blocked_by: ['c'] }),
      task('c', { status: 'in-progress' }),
    ],
    ready: [],
  },
  {
    name: 'a task that blocks another one is ready itself',
    tasks: [task('a', { blocking: ['b'] }), task('b')],
    ready: ['a'],
  },
];

describe('the ready tasks', () => {
  it.each(fixtures)('$name', ({ tasks, ready: expected }) => {
    expect(ready(tasks).map((found) => found.id)).toEqual(expected);
  });

  it('picks the most urgent of the ready tasks', () => {
    const tasks = [
      task('low', { priority: 'low' }),
      task('high', { priority: 'high' }),
      task('critical', { priority: 'critical' }),
    ];
    expect(next(tasks)?.id).toBe('critical');
  });

  it('has no next task when nothing is ready', () => {
    expect(next([task('a', { status: 'paused' })])).toBeUndefined();
  });

  it('sorts by status, then priority, then order, then age', () => {
    const tasks = [
      task('later', { order: 'V', created_at: '2026-01-02T00:00:00Z' }),
      task('earlier', { order: 'V', created_at: '2026-01-01T00:00:00Z' }),
      task('ordered', { order: 'A', created_at: '2026-01-03T00:00:00Z' }),
      task('urgent', { priority: 'critical', created_at: '2026-01-04T00:00:00Z' }),
    ];
    expect(ready(tasks).map((found) => found.id)).toEqual([
      'urgent',
      'ordered',
      'earlier',
      'later',
    ]);
  });
});
