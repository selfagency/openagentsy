/**
 * The rules that need no compiler.
 *
 * The comment rules need a TypeScript parse to find the comments of a file,
 * and a parse is not free. The stylesheet, the page and the copy rules read
 * the text of a file and scan it, which is a read and a scan.
 *
 * The rules are split in two, then: this module holds the half that is
 * cheap, and `rules.ts` holds the whole set, the comment rules included.
 * The split is a split of the module graph and not only of the run, so a
 * package that imports this one does not carry the compiler.
 */
import { copyRules } from './copy/rules.js';
import { cssRules } from './css/rules.js';
import { htmlRules } from './html/rules.js';
import { createRegistry, type QualityRegistry, type QualityRule } from './rule.js';

/** The rules that need no compiler, in the order they run. */
export const compilerFreeRules: QualityRule[] = [...cssRules, ...htmlRules, ...copyRules];

/**
 * The registry of the rules that need no compiler.
 *
 * It is built when the module is loaded, so a floor rule that is marked
 * waivable throws here, before any file is read.
 */
export const compilerFreeRegistry: QualityRegistry = createRegistry(compilerFreeRules);
