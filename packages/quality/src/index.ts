/**
 * @openagentsy/quality
 *
 * The anti-slop checks: the rule registry, and the static rules that read
 * a stylesheet, a page and its copy.
 *
 * It is a library. The hooks package calls it, and nothing here decides
 * on its own what a person decided.
 */
export * from './copy/index.js';
export * from './css/index.js';
export * from './html/index.js';
export * from './markup/index.js';
export * from './rule.js';
export * from './rules.js';
