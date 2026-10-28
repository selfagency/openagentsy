import { type Plugin, PluginContextProvider } from '@opencode/plugin/tui';
import { createComponent } from 'solid-js';
import type { FootprintConfig } from '../config.js';
import { FootprintBlock } from './footprint.js';

/**
 * The tree the footprint test renders.
 *
 * The children are a getter, not a value, because the context provider reads
 * them inside its own render effect: a child that is built before the
 * provider runs would look for a context that is not there yet.
 */
export function footprintTree(context: Plugin.Context, config: FootprintConfig) {
  return createComponent(PluginContextProvider, {
    value: context,
    get children() {
      return createComponent(FootprintBlock, { sessionID: 'ses_fixture', config });
    },
  });
}
