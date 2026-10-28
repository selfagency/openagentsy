import { describe, expect, it } from 'vitest';
import { PANEL_NAME } from '../panel.js';
import { collapseStore } from '../persist.js';
import { CONFIG, MESSAGES } from '../testing/fixtures.js';
import { clickFrame, fakeHost, renderFrame } from '../testing/harness.js';
import { footprintTree } from './footprint.render.js';
import { methodTree } from './method.render.js';

/**
 * The method panel.
 *
 * The panel is opened under a name, and the name is the contract between the
 * block that opens it and the plugin that draws it. The test opens it the
 * way a person does - a click on the link under the block - and reads the
 * name the host was given.
 */
describe('the method panel', () => {
  it('opens under the name the block asks for', async () => {
    const host = fakeHost({ messages: MESSAGES });
    const collapse = collapseStore(host.context);
    const rows = (await renderFrame(() => footprintTree(host.context, CONFIG, collapse))).split(
      '\n',
    );
    const row = rows.findIndex((line) => line.includes('method and sources'));
    expect(row).toBeGreaterThan(-1);
    const column = (rows[row]?.indexOf('method') ?? 0) + 2;

    await clickFrame(() => footprintTree(host.context, CONFIG, collapse), { x: column, y: row });

    expect(host.panels).toEqual([PANEL_NAME]);
    expect(host.panels.at(0)).toBe('openagentsy.footprint.method');
  });

  it('shows the method and its sources', async () => {
    const host = fakeHost();
    const text = await renderFrame(() => methodTree(host.context));

    expect(text).toContain('How this is estimated');
    expect(text).toContain('EcoLogits methodology');
    expect(text).toContain('CC BY-SA 4.0');
    expect(text).toContain('NOTICE');
  });
});
