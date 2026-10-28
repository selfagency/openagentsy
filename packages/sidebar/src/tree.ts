import { type Plugin, PluginContextProvider } from '@opencode/plugin/tui';
import { createComponent, type JSX } from 'solid-js';

/**
 * The tree a block test renders.
 *
 * The children are a getter, not a value, because the context provider reads
 * them inside its own render effect: a child that is built before the
 * provider runs would look for a context that is not there yet.
 */
export function blockTree(context: Plugin.Context, child: () => JSX.Element): JSX.Element {
  return createComponent(PluginContextProvider, {
    value: context,
    get children() {
      return child();
    },
  });
}
