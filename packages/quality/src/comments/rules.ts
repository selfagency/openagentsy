/**
 * The comment rules.
 *
 * Six rules, each one a pure function of the text of a file. They are
 * the mechanical half of the counterweight of §10.3: the tells of
 * anti-slop-code, and the preserve list that keeps them off the
 * comments that explain something.
 *
 * A rule of the comments is a reflex rule. A comment is never an
 * honesty, a function or an accessibility failure, so a comment must
 * never block a task, and a floor rule could not be waived at all. The
 * tells are mechanical, and the plan puts the mechanical ones in
 * reflex: a person may waive one with a reason. They are not taste
 * either, because a pattern decides each one of them, and the taste
 * about a comment belongs to the `oa-comments` skill.
 */
import { defineRule, type QualityRule, type RuleFinding, type SourceFile } from '../rule.js';
import { SAYING, type Tell, toldOf } from './tells.js';

/** The globs the comment rules apply to. */
const CODE_GLOBS = ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'];

/**
 * A banner separator, or a section label in capitals.
 *
 * A row of dashes says where the reader is, and the code says it too.
 * A label in capitals says the same in words, and the names of the
 * declarations below it say it better. A label of one word is left
 * alone: a word in capitals is often an acronym.
 */
export const bannerSeparator = defineRule({
  id: 'comment/banner-separator',
  source: 'antislop-code:banner-separator',
  tier: 'reflex',
  appliesTo: CODE_GLOBS,
  waivable: true,
  check: (file) => findingsOf(file, 'banner-separator'),
});

/**
 * A decorative emoji, or an end marker.
 *
 * The emoji carry no information, and the end marker says where a
 * block ends, which the brace says as well. A marker that explains
 * something is not a marker: `// end of the retry loop` says why the
 * loop is there.
 */
export const decorativeMarker = defineRule({
  id: 'comment/decorative-marker',
  source: 'antislop-code:decorative-marker',
  tier: 'reflex',
  appliesTo: CODE_GLOBS,
  waivable: true,
  check: (file) => findingsOf(file, 'decorative-marker'),
});

/**
 * A step of the code, written out.
 *
 * `// Step 1:` narrates the code, and the code is the narration. The
 * comment that says why the step is there is a different comment, and
 * the preserve list keeps it.
 */
export const stepNarration = defineRule({
  id: 'comment/step-narration',
  source: 'antislop-code:step-narration',
  tier: 'reflex',
  appliesTo: CODE_GLOBS,
  waivable: true,
  check: (file) => findingsOf(file, 'step-narration'),
});

/**
 * A label that says nothing.
 *
 * "Main logic" and "Helper function" name a kind of code instead of
 * saying what the code does, and the declaration says the same. The
 * label in capitals is the banner rule's, so it is not reported twice.
 */
export const emptyLabel = defineRule({
  id: 'comment/empty-label',
  source: 'antislop-code:empty-label',
  tier: 'reflex',
  appliesTo: CODE_GLOBS,
  waivable: true,
  check: (file) => findingsOf(file, 'empty-label'),
});

/**
 * A TODO that names no task.
 *
 * "TODO" and "TODO: fix" say that something is wrong and not what to
 * do about it. A TODO that names the task is a task, and the rule
 * leaves it alone.
 */
export const emptyTodo = defineRule({
  id: 'comment/empty-todo',
  source: 'antislop-code:empty-todo',
  tier: 'reflex',
  appliesTo: CODE_GLOBS,
  waivable: true,
  check: (file) => findingsOf(file, 'empty-todo'),
});

/**
 * A JSDoc that only repeats the signature.
 *
 * The words of the comment have to be words of the signature: the name
 * of the declaration, the names of its parameters and the types it
 * takes. A word that is nowhere in the signature means the comment
 * says something, and then it is not a finding.
 */
export const redundantJsDoc = defineRule({
  id: 'comment/redundant-jsdoc',
  source: 'antislop-code:redundant-jsdoc',
  tier: 'reflex',
  appliesTo: CODE_GLOBS,
  waivable: true,
  check: (file) => findingsOf(file, 'redundant-jsdoc'),
});

/** The findings of the comments of a file that carry a tell. */
function findingsOf(file: SourceFile, tell: Tell): RuleFinding[] {
  const findings: RuleFinding[] = [];
  for (const told of toldOf(file)) {
    if (told.tell !== tell) continue;
    const saying = SAYING[told.tell];
    findings.push({
      line: told.comment.line,
      message: saying.message,
      fix: saying.fix,
    });
  }
  return findings;
}

/** The comment rules, in the order they run. */
export const commentRules: QualityRule[] = [
  bannerSeparator,
  decorativeMarker,
  stepNarration,
  emptyLabel,
  emptyTodo,
  redundantJsDoc,
];
