import { type CopyText, copyOf } from '../markup/copy.js';
import { markupOf } from '../markup/document.js';
import {
  classNames,
  elementsWithAncestors,
  hasAttribute,
  lineAt,
  type MarkupDocument,
  type MarkupNode,
} from '../markup/scanner.js';
import { defineRule, designTurnsOff, type QualityRule, type RuleFinding } from '../rule.js';

/**
 * The copy rules.
 *
 * Four rules, each one a pure function of the text of a page. They are
 * adapted from miqdadbadjuber/anti-slop and Nutlope/hallmark, MIT. See
 * NOTICE.
 */

/** The globs the copy rules apply to. */
const MARKUP_GLOBS = ['**/*.{html,htm,tsx,jsx,vue,svelte}'];

/**
 * A claim with no source.
 *
 * A number, a testimonial and a wall of logos are claims: they say
 * something about the product, and the reader takes it at the word of the
 * page. So the claim has to say where it came from, either in a
 * `<!-- source: ... -->` comment next to it or in a `data-placeholder`
 * marker on the element that holds it. The copy does not have to go: a
 * claim with a source is a fine claim.
 */
export const unsourcedClaim = defineRule({
  id: 'copy/unsourced-claim',
  source: ['antislop:R-17', 'antislop:R-18', 'antislop:R-36', 'hallmark:floor-8'],
  tier: 'floor',
  appliesTo: MARKUP_GLOBS,
  waivable: false,
  check: (file) => {
    const document = markupOf(file);
    if (document === undefined) return [];
    const findings: RuleFinding[] = [];
    for (const text of copyOf(document)) {
      const claim = claimIn(text);
      if (claim === undefined) continue;
      if (isResolved(text.element, text.ancestors)) continue;
      findings.push({ ...claim, kind: 'claim' });
    }
    for (const wall of logoWalls(document)) {
      if (isResolved(wall.element, wall.ancestors)) continue;
      findings.push({
        line: wall.element.line,
        message: 'The page shows a wall of logos with no source.',
        fix: 'Cite where the logos came from, or mark the wall as a placeholder',
        kind: 'claim',
      });
    }
    return findings;
  },
});

/** The attribute a placeholder marker is written with. */
const PLACEHOLDER = 'data-placeholder';

/** A number that makes a claim. */
const NUMERIC_CLAIM = /\b\d+(?:[.,]\d+)?\s*(?:%|[km]\+|x)(?![a-z0-9])/i;

/** A quotation with a name after it. */
const QUOTED_ATTRIBUTION = /["“][^"”]{8,}["”]\s*[—–-]\s*\p{Lu}\p{L}+\s+\p{Lu}/u;

/** The claim a piece of copy makes, when it makes one. */
function claimIn(
  text: CopyText,
): Omit<RuleFinding, 'ruleId' | 'source' | 'tier' | 'file'> | undefined {
  const numeric = NUMERIC_CLAIM.exec(text.text);
  if (numeric !== null) {
    return {
      line: lineAt(text.line, text.text, numeric.index),
      message: `The copy makes the claim ${numeric[0]} with no source.`,
      fix: 'Cite where the claim comes from, or mark it as a placeholder',
    };
  }
  if (isTestimonial(text.element)) {
    return {
      line: text.line,
      message: 'The copy is a testimonial with no source.',
      fix: 'Cite where the testimonial comes from, or mark it as a placeholder',
    };
  }
  const quoted = QUOTED_ATTRIBUTION.exec(text.text);
  if (quoted !== null) {
    return {
      line: lineAt(text.line, text.text, quoted.index),
      message: 'The copy quotes a customer with no source.',
      fix: 'Cite where the quotation comes from, or mark it as a placeholder',
    };
  }
  return undefined;
}

/** Whether an element holds a testimonial. */
function isTestimonial(element: MarkupNode | undefined): boolean {
  if (element === undefined) return false;
  if (element.name === 'blockquote' || element.name === 'q') return true;
  return classNames(element).some((name) =>
    /(^|[-_])(testimonial|quote|review)([-_]|$)/.test(name),
  );
}

/** A container of logos. */
function isLogoContainer(node: MarkupNode): boolean {
  return classNames(node).some(
    (name) =>
      /(^|[-_])(logo|logos|client|clients|brand|brands|partner|partners)([-_]|$)/.test(name) ||
      /(^|[-_])trusted[-_]?by([-_]|$)/.test(name),
  );
}

/** The walls of logos of a document. */
function logoWalls(document: MarkupDocument): { element: MarkupNode; ancestors: MarkupNode[] }[] {
  const walls: { element: MarkupNode; ancestors: MarkupNode[] }[] = [];
  for (const { node, ancestors } of elementsWithAncestors(document.root)) {
    if (!isLogoContainer(node)) continue;
    if (countLogos(node) < 2) continue;
    walls.push({ element: node, ancestors });
  }
  return walls;
}

/** The logos inside a container. */
function countLogos(node: MarkupNode): number {
  let count = 0;
  for (const { node: child } of elementsWithAncestors(node)) {
    if (child.name === 'img' || isLogoContainer(child)) count += 1;
  }
  return count;
}

/**
 * Whether a claim has been sourced.
 *
 * A `data-placeholder` marker on the element, or on any element around it,
 * says the copy is a placeholder. A `<!-- source: ... -->` comment says
 * where the claim came from: in the element that holds the claim, or
 * right before it, or right before the element that holds it.
 */
function isResolved(element: MarkupNode | undefined, ancestors: readonly MarkupNode[]): boolean {
  if (element === undefined) return false;
  if (hasAttribute(element, PLACEHOLDER)) return true;
  for (const ancestor of ancestors) {
    if (hasAttribute(ancestor, PLACEHOLDER)) return true;
  }
  if (holdsSourceComment(element)) return true;
  const parent = ancestors[ancestors.length - 1];
  if (parent === undefined) return false;
  if (isSourceComment(previousContentSibling(parent, element))) return true;
  const grandparent = ancestors[ancestors.length - 2];
  if (grandparent === undefined) return false;
  return isSourceComment(previousContentSibling(grandparent, parent));
}

/** Whether an element holds a source comment. */
function holdsSourceComment(element: MarkupNode): boolean {
  return element.children.some((child) => isSourceComment(child));
}

/** Whether a node is a source comment. */
function isSourceComment(node: MarkupNode | undefined): boolean {
  if (node === undefined) return false;
  return node.kind === 'comment' && /^\s*source\s*:/i.test(node.text);
}

/**
 * The node before a child of a parent, or nothing.
 *
 * The white space between two elements is a text node of its own, and it
 * is not what sits before an element: a source comment written above an
 * element is separated from it by a line break. So the white space is
 * skipped, and the node that answers is the one a reader would call the
 * previous one.
 */
function previousContentSibling(parent: MarkupNode, child: MarkupNode): MarkupNode | undefined {
  const index = parent.children.indexOf(child);
  for (let at = index - 1; at >= 0; at -= 1) {
    const sibling = parent.children[at];
    if (sibling === undefined) continue;
    if (sibling.kind === 'text' && sibling.text.trim() === '') continue;
    return sibling;
  }
  return undefined;
}

/**
 * A call to action that says nothing.
 *
 * "Get Started" and "Learn More" are the same two words on every page, and
 * they say nothing about what a person gets. The copy has an object: the
 * thing the reader does next.
 */
export const genericCta = defineRule({
  id: 'copy/generic-cta',
  source: 'antislop',
  tier: 'reflex',
  appliesTo: MARKUP_GLOBS,
  waivable: true,
  check: (file) => {
    const document = markupOf(file);
    if (document === undefined) return [];
    const findings: RuleFinding[] = [];
    for (const text of copyOf(document)) {
      if (!isGenericCta(text.text)) continue;
      findings.push({
        line: text.line,
        message: 'The call to action says nothing about what the reader gets.',
        fix: 'Name what the reader gets, e.g. "Start your free trial"',
      });
    }
    return findings;
  },
});

/** The calls to action that say nothing. */
const GENERIC_CTA = new Set(['get started', 'get started now', 'learn more', 'read more']);

/** Whether a piece of copy is a call to action with no object. */
function isGenericCta(text: string): boolean {
  const cleaned = text
    .trim()
    .toLowerCase()
    .replace(/[.!?:»›→]+$/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return GENERIC_CTA.has(cleaned);
}

/**
 * A buzzword.
 *
 * The list is the project's: the rule has one of its own, and a project
 * that objects to other words names them in `CheckCtx.config.buzzwords`.
 */
export const buzzwords = defineRule({
  id: 'copy/buzzwords',
  source: 'antislop',
  tier: 'reflex',
  appliesTo: MARKUP_GLOBS,
  waivable: true,
  check: (file, ctx) => {
    const document = markupOf(file);
    if (document === undefined) return [];
    const list = ctx.config?.buzzwords ?? DEFAULT_BUZZWORDS;
    const findings: RuleFinding[] = [];
    for (const text of copyOf(document)) {
      for (const word of list) {
        const at = indexOfWord(text.text, word);
        if (at === -1) continue;
        findings.push({
          line: lineAt(text.line, text.text, at),
          message: `The copy uses the buzzword ${word}.`,
          fix: 'Say what the thing does, instead of the buzzword',
        });
      }
    }
    return findings;
  },
});

/** The words the buzzword rule rejects when the project has no list. */
const DEFAULT_BUZZWORDS = [
  'seamless',
  'revolutionary',
  'next-generation',
  'cutting-edge',
  'game-changing',
  'world-class',
  'best-in-class',
  'state-of-the-art',
  'unlock',
  'unleash',
  'elevate',
  'supercharge',
  'enterprise-grade',
  'mission-critical',
  'holistic',
  'synergy',
  'disrupt',
  'paradigm',
  'frictionless',
  'future-proof',
  'bleeding-edge',
  'turnkey',
  'one-stop',
  'blazing-fast',
  'ai-powered',
  'industry-leading',
  'market-leading',
  'first-in-class',
];

/** The place a word stands in a piece of copy, or -1. */
function indexOfWord(text: string, word: string): number {
  const pattern = new RegExp(`\\b${escapeForRegExp(word)}\\b`, 'iu');
  const found = pattern.exec(text);
  return found?.index ?? -1;
}

/** A word, with the characters a regular expression would read. */
function escapeForRegExp(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * An em dash in the copy.
 *
 * The rule is off by default, so a project has to ask for it with
 * `CheckCtx.config.enable`. It only reads the copy of a page: the text of
 * a document, and the text of a comment, are not copy and are never
 * touched.
 */
export const emDash = defineRule({
  id: 'copy/em-dash',
  source: 'antislop:R-02',
  tier: 'finish',
  appliesTo: MARKUP_GLOBS,
  waivable: true,
  offByDefault: true,
  check: (file, ctx) => {
    if (designTurnsOff(ctx.design, 'copy/em-dash', 'finish')) return [];
    const document = markupOf(file);
    if (document === undefined) return [];
    const findings: RuleFinding[] = [];
    for (const text of copyOf(document)) {
      const at = text.text.indexOf('—');
      if (at === -1) continue;
      findings.push({
        line: lineAt(text.line, text.text, at),
        message: 'The copy has an em dash.',
        fix: 'Replace the em dash with a full stop or a comma',
      });
    }
    return findings;
  },
});

/** The copy rules, in the order they run. */
export const copyRules: QualityRule[] = [unsourcedClaim, genericCta, buzzwords, emDash];
