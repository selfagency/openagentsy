import type { Plugin } from '@opencode/plugin/tui';
import { createComponent } from 'solid-js';
import type { CollapseStore } from '../persist.js';
import type { BudgetView } from '../readers.js';
import { blockTree } from '../tree.js';
import { BudgetBlock } from './budget.js';

/** The tree the budget test renders. */
export function budgetTree(context: Plugin.Context, view: BudgetView, collapse: CollapseStore) {
  return blockTree(context, () => createComponent(BudgetBlock, { view, collapse }));
}
