import type { Plugin } from '@opencode/plugin/tui';
import { createComponent } from 'solid-js';
import type { CollapseStore } from '../persist.js';
import type { AccountabilityView } from '../readers.js';
import { blockTree } from '../tree.js';
import { AccountabilityBlock } from './accountability.js';

/** The tree the accountability test renders. */
export function accountabilityTree(
  context: Plugin.Context,
  view: AccountabilityView,
  collapse: CollapseStore,
) {
  return blockTree(context, () => createComponent(AccountabilityBlock, { view, collapse }));
}
