import { type Task, TERMINAL } from './model.js';
import { ready } from './query.js';

/**
 * The prime block: what a session is told about the tasks, in a few lines.
 *
 * It is a state summary, not a manual. The rules live in the code and the
 * conventions live in a skill, so the block carries the numbers and the
 * names, and nothing else. It goes into the system prompt on every message,
 * so it is also a cost: it stays under two hundred tokens, and it says
 * nothing that is not about tasks.
 */

/** How many tasks in progress the block names. */
const IN_PROGRESS_SHOWN = 3;

/** How many ready tasks the block names. */
const READY_SHOWN = 5;

/**
 * How much of a title the block carries.
 *
 * A title is a sentence a person wrote, and a block that quotes it in full
 * is a block that grows. The first forty characters are enough to tell two
 * tasks apart.
 */
const TITLE_LIMIT = 40;

/**
 * The block.
 *
 * The open tasks are counted, the ones in progress and the ones ready are
 * named, and the tools that read and change them are pointed at. Nothing
 * else is in here: a block that grew into anything but the task state would
 * cost tokens on every message and answer no question.
 */
export function primeBlock(tasks: Task[]): string {
  const live = tasks.filter((task) => !TERMINAL.has(task.status));
  const inProgress = live.filter((task) => task.status === 'in-progress');
  const open = ready(tasks);
  const top = open.slice(0, READY_SHOWN);

  return [
    '## Project tasks (.beans)',
    `${live.length} open; ${inProgress.length} in progress; ${open.length} ready.`,
    inProgress.length > 0
      ? `In progress:\n${inProgress.slice(0, IN_PROGRESS_SHOWN).map(line).join('\n')}`
      : '',
    top.length > 0 ? `Ready next:\n${top.map(line).join('\n')}` : '',
    'Use the oa_task_* tools to read or change tasks.',
  ]
    .filter((part) => part !== '')
    .join('\n');
}

/** One task, as one line of the block. */
const line = (task: Task): string =>
  `- ${task.id} [${task.type ?? 'task'}/${task.priority ?? 'normal'}] ${short(task.title)}`;

/** A title, cut to what the block can carry. */
const short = (title: string): string =>
  title.length > TITLE_LIMIT ? `${title.slice(0, TITLE_LIMIT - 1)}…` : title;
