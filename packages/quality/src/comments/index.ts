/**
 * The comment lint.
 *
 * The counterweight to the static rules: the tells of anti-slop-code,
 * the preserve list that keeps them off the comments that explain
 * something, and the fix that may only touch the comments.
 */
export * from './ast.js';
export * from './fix.js';
export * from './preserve.js';
export * from './rules.js';
export * from './scanner.js';
export * from './tells.js';
