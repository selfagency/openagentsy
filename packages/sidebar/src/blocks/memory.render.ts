import type { Plugin } from '@opencode/plugin/tui';
import { createComponent } from 'solid-js';
import type { CollapseStore } from '../persist.js';
import type { MemoryView } from '../readers.js';
import { blockTree } from '../tree.js';
import { MemoryInboxBlock } from './memory.js';

/** The tree the memory inbox test renders. */
export function memoryTree(context: Plugin.Context, view: MemoryView, collapse: CollapseStore) {
  return blockTree(context, () => createComponent(MemoryInboxBlock, { view, collapse }));
}
