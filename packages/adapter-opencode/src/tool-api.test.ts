import {
  defineTool as coreDefineTool,
  toolMap as coreToolMap,
  v2Tool as coreV2Tool,
} from '@openagentsy/core';
import { describe, expect, it } from 'vitest';
import { defineTool, toolMap, v2Tool } from './index.js';

/**
 * The tool helper the adapter offers.
 *
 * The definitions live in core, because a package that publishes tools may
 * not depend on a package that never goes on npm. The adapter still offers
 * the same helper, so that nothing that imports it breaks, and the helper it
 * offers is the one from core and not a copy of it.
 */
describe('the tool helper the adapter offers', () => {
  it('is the one from core', () => {
    expect(defineTool).toBe(coreDefineTool);
    expect(toolMap).toBe(coreToolMap);
    expect(v2Tool).toBe(coreV2Tool);
  });
});
