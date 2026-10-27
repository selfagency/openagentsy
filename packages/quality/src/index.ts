/**
 * @openagentsy/quality
 *
 * The anti-slop checks: the rule registry, and the static rules that read
 * a stylesheet.
 *
 * It is a library. The hooks package calls it, and nothing here decides
 * on its own what a person decided.
 */
export * from './css/index.js';
export * from './rule.js';
