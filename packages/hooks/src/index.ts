/**
 * @openagentsy/hooks
 *
 * The deterministic guardrails: the rule registry, the default rules, the
 * output checks, the shell environment policy, the redaction wrapper and
 * the approval gate.
 *
 * It is a library. The adapter (the OpenCode plugin) calls it; OpenCode
 * never loads it, and nothing here decides on its own what a person
 * decided.
 */
export * from './accountability.js';
export * from './approvals.js';
export * from './base-tool.js';
export * from './eval/index.js';
export * from './event.js';
export * from './lessons/index.js';
export * from './output-checks.js';
export * from './paths.js';
export * from './quality/index.js';
export * from './registry.js';
export * from './rules.js';
export * from './secrets.js';
export * from './shell-env.js';
