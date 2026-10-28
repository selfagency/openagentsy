/** @jsxImportSource @opentui/solid */

import { resolveProjectRoots } from '@openagentsy/core';
import { Plugin } from '@opencode/plugin/tui';
import { createSignal } from 'solid-js';
import { AccountabilityBlock } from './blocks/accountability.js';
import { BoardBlock } from './blocks/board.js';
import { BudgetBlock } from './blocks/budget.js';
import { FootprintBlock } from './blocks/footprint.js';
import { MemoryInboxBlock } from './blocks/memory.js';
import { MethodPanel } from './blocks/method.js';
import { TasksBlock } from './blocks/tasks.js';
import { type FootprintConfig, readFootprintConfig } from './config.js';
import { PANEL_NAME } from './panel.js';
import { collapseStore } from './persist.js';
import {
  type AccountabilityView,
  type BoardView,
  type BudgetView,
  type MemoryView,
  readAccountability,
  readBoard,
  readBudget,
  readMemory,
  readTasks,
  type TasksView,
} from './readers.js';

/**
 * The OpenAgentsy sidebar.
 *
 * The plugin claims the `sidebar.content` slot and draws the blocks in it.
 * The host owns the slot tree, and a claim names one placement key and a
 * render function; the render function is handed the session the sidebar is
 * showing.
 *
 * The method panel is a second claim, on the `session.panel` slot. The host
 * has no panel registry: `ui.panel.open` sets a name, and the claims on that
 * slot decide which of them is the panel being shown.
 */

/** The views the blocks render. */
type Views = {
  board: BoardView;
  tasks: TasksView;
  budget: BudgetView;
  memory: MemoryView;
  accountability: AccountabilityView;
};

/**
 * The views of a project, read once when the plugin starts.
 *
 * The board and the ledger are the state root's, and the tasks are the
 * workspace's: a session in a worktree reads the board of the project and
 * the tasks of its own branch (§3.9).
 */
async function loadViews(directory: string): Promise<Views> {
  const roots = resolveProjectRoots(directory);
  const [board, tasks, budget, memory, accountability] = await Promise.all([
    readBoard(roots.stateRoot),
    readTasks(roots.workspace),
    readBudget(roots.stateRoot),
    readMemory(roots.stateRoot),
    readAccountability(roots.stateRoot),
  ]);
  return { board, tasks, budget, memory, accountability };
}

export default Plugin.define({
  id: 'openagentsy.sidebar',
  setup(context) {
    const [config, setConfig] = createSignal<FootprintConfig | undefined>(undefined);
    const [views, setViews] = createSignal<Views | undefined>(undefined);
    const collapse = collapseStore(context);

    const root = context.location?.directory;
    if (root) {
      void readFootprintConfig(root).then(setConfig, () => undefined);
      void loadViews(root).then(setViews, () => undefined);
    }

    const releaseBlock = context.ui.slot({
      append: 'sidebar.content',
      render: (input) => {
        const current = config();
        const loaded = views();
        return (
          <box flexDirection="column">
            {current && (
              <FootprintBlock sessionID={input.sessionID} config={current} collapse={collapse} />
            )}
            {loaded && (
              <>
                <BoardBlock view={loaded.board} collapse={collapse} />
                <TasksBlock view={loaded.tasks} collapse={collapse} />
                <BudgetBlock view={loaded.budget} collapse={collapse} />
                <MemoryInboxBlock view={loaded.memory} collapse={collapse} />
                <AccountabilityBlock view={loaded.accountability} collapse={collapse} />
              </>
            )}
          </box>
        );
      },
    });

    const releasePanel = context.ui.slot({
      append: 'session.panel',
      render: (input) => (input.name === PANEL_NAME ? <MethodPanel /> : null),
    });

    return () => {
      releaseBlock();
      releasePanel();
    };
  },
});
