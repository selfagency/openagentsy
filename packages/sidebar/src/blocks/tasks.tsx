/** @jsxImportSource @opentui/solid */

import { usePlugin } from '@opencode/plugin/tui';
import { For, Show } from 'solid-js';
import { fmtCount } from '../format.js';
import { type CollapseStore, useCollapsed } from '../persist.js';
import type { TasksView } from '../readers.js';

/**
 * The tasks block.
 *
 * It says what is being worked on, what can be picked up next and how many
 * tasks are held up. The store is the task store's, and the answer to
 * "blocked" is the store's own: a task is blocked when something in front of
 * it is not finished, and the store walks the parent chain to say so.
 */
export function TasksBlock(props: { view: TasksView; collapse: CollapseStore }) {
  const context = usePlugin();
  const [open, toggle] = useCollapsed(props.collapse, 'tasks');

  const base = () => context.theme.text.base;
  const muted = () => context.theme.text.muted;

  return (
    <box>
      <box flexDirection="row" gap={1} onMouseDown={() => void toggle()}>
        <text fg={base()}>{open() ? '▼' : '▶'}</text>
        <text fg={base()}>
          <b>Tasks</b>
        </text>
        <text fg={muted()}>
          {fmtCount(props.view.inProgress.length)} in progress · {fmtCount(props.view.ready.length)}{' '}
          ready · {fmtCount(props.view.blocked)} blocked
        </text>
      </box>
      <Show when={open()}>
        <For each={props.view.inProgress}>
          {(task) => (
            <text fg={muted()}>
              in progress · {task.id} {task.title}
            </text>
          )}
        </For>
        <For each={props.view.ready}>
          {(task) => (
            <text fg={muted()}>
              ready · {task.id} {task.title}
            </text>
          )}
        </For>
        <Show when={props.view.inProgress.length === 0 && props.view.ready.length === 0}>
          <text fg={muted()}>no open task</text>
        </Show>
      </Show>
    </box>
  );
}
