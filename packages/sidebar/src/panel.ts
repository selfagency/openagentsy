/**
 * The name the method panel is opened under.
 *
 * The host has no panel registry: a plugin claims the `session.panel` slot
 * and decides which panel it is drawing, by the name the host puts in the
 * slot input. The name is therefore the contract between the block that
 * opens the panel and the plugin that draws it.
 */
export const PANEL_NAME = 'openagentsy.footprint.method';
