/** @jsxImportSource @opentui/solid */

import { Plugin } from '@opencode/plugin/tui';
import { createSignal } from 'solid-js';
import { FootprintBlock } from './blocks/footprint.js';
import { MethodPanel } from './blocks/method.js';
import { type FootprintConfig, readFootprintConfig } from './config.js';
import { PANEL_NAME } from './panel.js';

/**
 * The OpenAgentsy sidebar.
 *
 * The plugin claims the `sidebar.content` slot and draws the footprint block
 * in it. The host owns the slot tree, and a claim names one placement key
 * and a render function; the render function is handed the session the
 * sidebar is showing.
 *
 * The method panel is a second claim, on the `session.panel` slot. The host
 * has no panel registry: `ui.panel.open` sets a name, and the claims on that
 * slot decide which of them is the panel being shown.
 */
export default Plugin.define({
  id: 'openagentsy.sidebar',
  setup(context) {
    const [config, setConfig] = createSignal<FootprintConfig | undefined>(undefined);

    const root = context.location?.directory;
    if (root) {
      void readFootprintConfig(root).then(setConfig, () => undefined);
    }

    const releaseBlock = context.ui.slot({
      append: 'sidebar.content',
      render: (input) => {
        const current = config();
        if (!current) return null;
        return <FootprintBlock sessionID={input.sessionID} config={current} />;
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
