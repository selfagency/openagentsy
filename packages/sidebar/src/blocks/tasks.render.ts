import type { Plugin } from '@opencode/plugin/tui';
import { createComponent } from 'solid-js';
import type { CollapseStore } from '../persist.js';
import type { TasksView } from '../readers.js';
import { blockTree } from '../tree.js';
import { TasksBlock } from './tasks.js';

/** The tree the tasks test renders. */
export function tasksTree(context: Plugin.Context, view: TasksView, collapse: CollapseStore) {
  return blockTree(context, () => createComponent(TasksBlock, { view, collapse }));
}
