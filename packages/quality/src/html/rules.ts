import { markupOf } from '../markup/document.js';
import {
  attribute,
  classNames,
  elementsWithAncestors,
  hasAttribute,
  type MarkupDocument,
  type MarkupNode,
} from '../markup/scanner.js';
import { defineRule, designTurnsOff, type QualityRule, type RuleFinding } from '../rule.js';

/**
 * The HTML rules.
 *
 * Four rules, each one a pure function of the text of a page. They are
 * adapted from miqdadbadjuber/anti-slop and Nutlope/hallmark, MIT. See
 * NOTICE.
 */

/** The globs the HTML rules apply to. */
const MARKUP_GLOBS = ['**/*.{html,htm,tsx,jsx,vue,svelte}'];

/**
 * A link to an anchor or a route that does not exist.
 *
 * The rule sees the anchors of the file it reads, so a link to an anchor
 * of the same file is judged there and then. A link to a route is a
 * different matter: the routes of a project are not in the file, so the
 * rule only judges it when the caller hands the routes over in
 * `CheckCtx.routes`. Without them the rule says nothing about a route
 * link, because a rule that guesses which routes exist is a rule that
 * reports a link as dead when it is not.
 */
export const deadNav = defineRule({
  id: 'html/dead-nav',
  source: 'antislop:R-24',
  tier: 'floor',
  appliesTo: MARKUP_GLOBS,
  waivable: false,
  check: (file, ctx) => {
    const document = markupOf(file);
    if (document === undefined) return [];
    const anchors = anchorsOf(document);
    const findings: RuleFinding[] = [];
    for (const link of linksOf(document)) {
      const target = targetOf(link);
      if (target === undefined) continue;
      if (target.startsWith('#')) {
        addFinding(findings, anchorFinding(target, anchors, link));
        continue;
      }
      addFinding(findings, routeFinding(target, ctx.routes, link));
    }
    return findings;
  },
});

/** Add a finding to the list, when there is one. */
function addFinding(findings: RuleFinding[], finding: RuleFinding | undefined): void {
  if (finding === undefined) return;
  findings.push(finding);
}

/** The target of a link, when it has one. */
function targetOf(link: MarkupNode): string | undefined {
  const href = attribute(link, 'href');
  if (href === undefined) return undefined;
  const target = href.trim();
  if (target === '') return undefined;
  return target;
}

/** The finding of a link to an anchor the file does not have. */
function anchorFinding(
  target: string,
  anchors: Set<string>,
  link: MarkupNode,
): RuleFinding | undefined {
  const anchor = target.slice(1);
  if (anchor === '') return undefined;
  if (anchors.has(anchor)) return undefined;
  return {
    line: link.line,
    message: `The link to #${anchor} names an id the file does not have.`,
    fix: 'Point the link at an id that exists, or add the element it names',
  };
}

/**
 * The finding of a link to a route the project does not have.
 *
 * Without the routes of the project the rule says nothing: a rule that
 * guesses which routes exist reports a link as dead when it is not.
 */
function routeFinding(
  target: string,
  routes: readonly string[] | undefined,
  link: MarkupNode,
): RuleFinding | undefined {
  if (isExternal(target)) return undefined;
  if (routes === undefined) return undefined;
  if (routes.some((route) => sameRoute(route, target))) return undefined;
  return {
    line: link.line,
    message: `The link to ${target} is not a route the project has.`,
    fix: 'Point the link at a route that exists',
  };
}

/** The ids the file has, from the elements and from the named anchors. */
function anchorsOf(document: MarkupDocument): Set<string> {
  const anchors = new Set<string>();
  for (const { node } of elementsWithAncestors(document.root)) {
    const id = attribute(node, 'id');
    if (id !== undefined && id.trim() !== '') anchors.add(id.trim());
    if (node.name !== 'a') continue;
    const name = attribute(node, 'name');
    if (name !== undefined && name.trim() !== '') anchors.add(name.trim());
  }
  return anchors;
}

/** The elements that link somewhere. */
function linksOf(document: MarkupDocument): MarkupNode[] {
  return elementsWithAncestors(document.root)
    .map((found) => found.node)
    .filter((node) => node.name === 'a' || node.name === 'area');
}

/** Whether a link leaves the project. */
function isExternal(target: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target) || target.includes('{');
}

/** Whether a link names the route the project has. */
function sameRoute(route: string, target: string): boolean {
  const wanted = normaliseRoute(route);
  const asked = normaliseRoute(target);
  if (wanted === asked) return true;
  return wanted.replace(/^\//, '') === asked.replace(/^\//, '');
}

/** A route without its query, its fragment and its trailing slash. */
function normaliseRoute(route: string): string {
  let value = route.trim();
  const fragment = value.indexOf('#');
  if (fragment !== -1) value = value.slice(0, fragment);
  const query = value.indexOf('?');
  if (query !== -1) value = value.slice(0, query);
  if (value.startsWith('./')) value = value.slice(2);
  if (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);
  return value;
}

/**
 * A control that does nothing.
 *
 * A button with no handler does nothing, and a form with no action and no
 * submit handler does nothing either. A submit button does what its form
 * does, so the form is the finding and the button is not reported twice.
 */
export const inertControl = defineRule({
  id: 'html/inert-control',
  source: 'antislop:R-26',
  tier: 'floor',
  appliesTo: MARKUP_GLOBS,
  waivable: false,
  check: (file) => {
    const document = markupOf(file);
    if (document === undefined) return [];
    const findings: RuleFinding[] = [];
    for (const { node, ancestors } of elementsWithAncestors(document.root)) {
      if (node.name === 'form') {
        if (!formIsInert(node)) continue;
        findings.push({
          line: node.line,
          message: 'The form has no action and no submit handler, so it does nothing.',
          fix: 'Give the form an action, or a submit handler',
        });
        continue;
      }
      if (!isButton(node)) continue;
      const finding = buttonFinding(node, ancestors);
      if (finding !== undefined) findings.push(finding);
    }
    return findings;
  },
});

/** Whether a form does nothing when it is submitted. */
function formIsInert(form: MarkupNode): boolean {
  const action = attribute(form, 'action');
  if (action !== undefined && action.trim() !== '') return false;
  if (hasHandler(form, 'submit')) return false;
  if ((attribute(form, 'method') ?? '').toLowerCase() === 'dialog') return false;
  return true;
}

/** Whether an element is a button. */
function isButton(node: MarkupNode): boolean {
  if (node.name === 'button') return true;
  if (node.name !== 'input') return false;
  const type = (attribute(node, 'type') ?? 'text').toLowerCase();
  return type === 'button' || type === 'submit' || type === 'reset' || type === 'image';
}

/** The finding of a button that does nothing, when it does. */
function buttonFinding(
  node: MarkupNode,
  ancestors: readonly MarkupNode[],
): RuleFinding | undefined {
  if (hasAttribute(node, 'disabled')) return undefined;
  if (hasHandler(node, 'click')) return undefined;
  const type = (attribute(node, 'type') ?? '').toLowerCase();
  const submits =
    node.name === 'input'
      ? type === 'submit' || type === 'image'
      : type !== 'button' && type !== 'reset';
  if (!submits) {
    return {
      line: node.line,
      message: 'The button has no handler, so it does nothing.',
      fix: 'Give the button a handler, or make it submit a form',
    };
  }
  if (nearest(ancestors, 'form') !== undefined) return undefined;
  return {
    line: node.line,
    message: 'The submit button is not in a form, so it does nothing.',
    fix: 'Put the button in a form that has an action',
  };
}

/** Whether an element carries a handler for an event. */
function hasHandler(node: MarkupNode, event: string): boolean {
  return node.attributes.some((held) => {
    const name = held.name.toLowerCase();
    return (
      name === `on${event}` ||
      name === `@${event}` ||
      name === `:on${event}` ||
      name === `v-on:${event}`
    );
  });
}

/** The nearest ancestor of a kind, or nothing. */
function nearest(ancestors: readonly MarkupNode[], name: string): MarkupNode | undefined {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = ancestors[index];
    if (ancestor !== undefined && ancestor.name === name) return ancestor;
  }
  return undefined;
}

/**
 * An emoji used as an icon.
 *
 * The emoji has to be the whole of a piece of text, and it has to sit
 * where an icon would: in a button, in a link, in a summary, or in an
 * element whose class names it an icon. An emoji in a sentence is prose
 * and is left alone.
 */
export const emojiIcon = defineRule({
  id: 'html/emoji-icon',
  source: 'hallmark:floor-11',
  tier: 'reflex',
  appliesTo: MARKUP_GLOBS,
  waivable: true,
  check: (file) => {
    const document = markupOf(file);
    if (document === undefined) return [];
    const findings: RuleFinding[] = [];
    for (const { node } of elementsWithAncestors(document.root)) {
      for (const child of node.children) {
        if (child.kind !== 'text') continue;
        if (!isEmojiOnly(child.text)) continue;
        if (!isIconContext(node)) continue;
        findings.push({
          line: child.line,
          message: 'The emoji is used as an icon.',
          fix: 'Replace the emoji with an icon from the icon set',
        });
      }
    }
    return findings;
  },
});

/** The characters that are not part of an emoji. */
const NOT_EMOJI = /[^\p{Extended_Pictographic}\p{Emoji_Presentation}\s]/u;

/**
 * The marks that belong to an emoji without being a character of their own.
 *
 * A variation selector, a joiner and a skin tone are written after the
 * character they belong to, so they are read apart from it.
 */
const EMOJI_MARK = /^(?:\p{Emoji_Modifier}|\uFE0F|\u200D)$/u;

/** Whether a piece of text holds a character that is not part of an emoji. */
function holdsNotEmoji(text: string): boolean {
  for (const char of text) {
    if (EMOJI_MARK.test(char)) continue;
    if (NOT_EMOJI.test(char)) return true;
  }
  return false;
}

/** Whether a piece of text is nothing but a short run of emoji. */
function isEmojiOnly(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '') return false;
  if (holdsNotEmoji(trimmed)) return false;
  const count = trimmed.match(/\p{Extended_Pictographic}/gu)?.length ?? 0;
  return count >= 1 && count <= 3;
}

/** Whether an element is where an icon would go. */
function isIconContext(node: MarkupNode): boolean {
  if (node.name === 'button' || node.name === 'a' || node.name === 'summary') return true;
  return classNames(node).some((name) =>
    /(^|[-_])(icon|emoji|glyph|symbol|logo)([-_]|$)/.test(name),
  );
}

/**
 * A card inside a card.
 *
 * A card is an element whose class is `card` or ends in `card`, or an
 * element that says it is a card with `role="card"`. A wrapper such as
 * `card-grid` is not a card, so a grid of cards is not a card in a card.
 */
export const cardInCard = defineRule({
  id: 'html/card-in-card',
  source: 'hallmark:floor-11',
  tier: 'finish',
  appliesTo: MARKUP_GLOBS,
  waivable: true,
  check: (file, ctx) => {
    if (designTurnsOff(ctx.design, 'html/card-in-card', 'finish')) return [];
    const document = markupOf(file);
    if (document === undefined) return [];
    const findings: RuleFinding[] = [];
    for (const { node, ancestors } of elementsWithAncestors(document.root)) {
      if (!isCard(node)) continue;
      if (!ancestors.some((ancestor) => isCard(ancestor))) continue;
      findings.push({
        line: node.line,
        message: 'The card is inside another card.',
        fix: 'Take the card out of the card, or flatten the layout',
      });
    }
    return findings;
  },
});

/** Whether an element is a card. */
function isCard(node: MarkupNode): boolean {
  if ((attribute(node, 'role') ?? '').toLowerCase() === 'card') return true;
  return classNames(node).some((name) => name === 'card' || /[-_]card$/.test(name));
}

/** The HTML rules, in the order they run. */
export const htmlRules: QualityRule[] = [deadNav, inertControl, emojiIcon, cardInCard];
