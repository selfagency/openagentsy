/**
 * Every rule, in one registry.
 *
 * The rules are split by what they read: nine read a stylesheet, four
 * read the structure of a page, four read the copy of a page and six
 * read the comments of a source file. The registry holds all of them,
 * and it is built once, at load, so a floor rule that a person could
 * waive stops the package from loading at all.
 */

import { commentRules } from './comments/rules.js';
import { copyRules } from './copy/rules.js';
import { cssRules } from './css/rules.js';
import { htmlRules } from './html/rules.js';
import { createRegistry, type QualityRegistry, type QualityRule } from './rule.js';

/** Every rule, the stylesheet ones first. */
export const allRules: QualityRule[] = [...cssRules, ...htmlRules, ...copyRules, ...commentRules];

/**
 * The registry of every rule.
 *
 * It is built when the module is loaded, so a floor rule that is marked
 * waivable throws here, before any file is read.
 */
export const qualityRegistry: QualityRegistry = createRegistry(allRules);
