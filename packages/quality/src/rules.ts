/**
 * Every rule, in one registry.
 *
 * The rules are split by what they read: nine read a stylesheet, four
 * read the structure of a page, four read the copy of a page and six
 * read the comments of a source file. The registry holds all of them,
 * and it is built once, at load, so a floor rule that a person could
 * waive stops the package from loading at all.
 *
 * The comment rules are the ones that need the TypeScript compiler, and
 * they are in `comments/`. A package that must not carry the compiler
 * imports `compiler-free.ts` instead of this one.
 */

import { commentRules } from './comments/rules.js';
import { compilerFreeRules } from './compiler-free.js';
import { createRegistry, type QualityRegistry, type QualityRule } from './rule.js';

/** Every rule, the comment rules last. */
export const allRules: QualityRule[] = [...compilerFreeRules, ...commentRules];

/**
 * The registry of every rule.
 *
 * It is built when the module is loaded, so a floor rule that is marked
 * waivable throws here, before any file is read.
 */
export const allRegistry: QualityRegistry = createRegistry(allRules);
