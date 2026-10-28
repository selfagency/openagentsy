import type { Plugin } from '@opencode/plugin/tui';
import { createComponent } from 'solid-js';
import type { CollapseStore } from '../persist.js';
import type { BoardView } from '../readers.js';
import { blockTree } from '../tree.js';
import { BoardBlock } from './board.js';

/** The tree the board test renders. */
export function boardTree(context: Plugin.Context, view: BoardView, collapse: CollapseStore) {
  return blockTree(context, () => createComponent(BoardBlock, { view, collapse }));
}
