import type { Plugin } from '@opencode/plugin/tui';
import { createComponent } from 'solid-js';
import { blockTree } from '../tree.js';
import { MethodPanel } from './method.js';

/** The tree the method panel test renders. */
export function methodTree(context: Plugin.Context) {
  return blockTree(context, () => createComponent(MethodPanel, {}));
}
