import {
  defineRule,
  designTurnsOff,
  type QualityRule,
  type RuleFinding,
  type SourceFile,
} from '../rule.js';
import { contrastRatio, hueOf, parseColour, type Rgb } from './colour.js';
import { allBlocks, type CssDeclaration, type CssDocument, scanCss } from './scanner.js';

/**
 * The CSS rules.
 *
 * Nine rules, each one a pure function of the text of a stylesheet. They
 * are adapted from Nutlope/hallmark and miqdadbadjuber/anti-slop, MIT.
 * See NOTICE.
 */

/** The globs the CSS rules apply to. */
const CSS_GLOBS = ['**/*.css'];

/**
 * The scan of a file.
 *
 * Nine rules read the same stylesheet, so the scan is kept and the second
 * rule to ask for it gets the first one's answer. A file is read as it
 * was when it was handed over.
 */
const scans = new WeakMap<SourceFile, CssDocument>();

function scanOf(file: SourceFile): CssDocument {
  const cached = scans.get(file);
  if (cached !== undefined) return cached;
  const document = scanCss(file.text);
  scans.set(file, document);
  return document;
}

/**
 * A colour written out in a stylesheet.
 *
 * The token rule rejects a colour that is spelled out, so the scanner
 * looks for the notations a stylesheet uses: hex, the colour functions
 * and the named colours. A named colour only counts where the property
 * takes one, because a font family called Red Hat is not a colour.
 */
const NAMED_COLOURS = new Set([
  'aqua',
  'black',
  'blue',
  'fuchsia',
  'gray',
  'green',
  'grey',
  'lime',
  'maroon',
  'navy',
  'olive',
  'purple',
  'red',
  'silver',
  'teal',
  'white',
  'yellow',
]);

/** The properties whose value is a colour. */
const COLOUR_PROPERTIES = new Set([
  'accent-color',
  'background',
  'background-color',
  'border',
  'border-block',
  'border-color',
  'border-inline',
  'border-left',
  'border-right',
  'border-top',
  'box-shadow',
  'caret-color',
  'column-rule-color',
  'fill',
  'outline',
  'outline-color',
  'scrollbar-color',
  'stroke',
  'text-decoration-color',
  'text-emphasis-color',
  'text-shadow',
]);

const HEX_COLOUR = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})\b/i;
const COLOUR_FUNCTION = /\b(?:rgba?|hsla?)\(/i;

/**
 * A literal colour or a font family outside a token block.
 *
 * Hallmark's first floor: a colour and a font family belong to the token
 * block, and a stylesheet that writes them out has two sources of truth
 * for the same value.
 */
export const tokenOnlyColourFont = defineRule({
  id: 'css/token-only-colour-font',
  source: 'hallmark:floor-1',
  tier: 'reflex',
  appliesTo: CSS_GLOBS,
  waivable: true,
  check: (file) => {
    const findings: RuleFinding[] = [];
    for (const block of allBlocks(scanOf(file))) {
      if (isTokenBlock(block.selector)) continue;
      const fontFace = block.atRules.some((at) => /^@font-face\b/i.test(at));
      for (const declaration of block.declarations) {
        if (isFontFamily(declaration) && !fontFace && !usesToken(declaration.value)) {
          findings.push({
            line: declaration.line,
            message: `The font family of ${block.selector} is written out instead of taken from a token.`,
            fix: 'Move the font family into a design token and use var() for it',
          });
          continue;
        }
        const colour = literalColour(declaration);
        if (colour === undefined) continue;
        findings.push({
          line: declaration.line,
          message: `The literal colour ${colour} of ${block.selector} is not a token.`,
          fix: 'Replace the literal colour with a design token',
        });
      }
    }
    return findings;
  },
});

/**
 * A transition of everything.
 *
 * `transition: all` moves every property, the layout ones included, so a
 * stylesheet that says it pays for a layout on every frame.
 */
export const noTransitionAll = defineRule({
  id: 'css/no-transition-all',
  source: 'hallmark:floor-2',
  tier: 'reflex',
  appliesTo: CSS_GLOBS,
  waivable: true,
  check: (file) => {
    const findings: RuleFinding[] = [];
    for (const block of allBlocks(scanOf(file))) {
      for (const declaration of block.declarations) {
        if (!isTransition(declaration)) continue;
        const first = declaration.value.split(/[\s,]+/).find((part) => part !== '');
        if (first?.toLowerCase() !== 'all') continue;
        findings.push({
          line: declaration.line,
          message: 'A transition of all moves every property, the layout ones included.',
          fix: 'Name the properties to transition instead of all',
        });
      }
    }
    return findings;
  },
});

/** Whether a declaration is a transition. */
function isTransition(declaration: CssDeclaration): boolean {
  return declaration.property === 'transition' || declaration.property === 'transition-property';
}

/** The properties whose animation lays the page out on every frame. */
const LAYOUT_PROPERTIES = new Set(['width', 'height', 'top', 'left']);

/**
 * An animation of a layout property.
 *
 * The animation is either a keyframes step that sets the property, or a
 * transition that names it. A stylesheet that sets a width in a rule and
 * never animates it is fine.
 */
export const noLayoutAnimation = defineRule({
  id: 'css/no-layout-animation',
  source: 'hallmark:floor-2',
  tier: 'reflex',
  appliesTo: CSS_GLOBS,
  waivable: true,
  check: (file) => {
    const document = scanOf(file);
    return [...keyframeFindings(document), ...transitionFindings(document)];
  },
});

/** The keyframe steps that set a layout property. */
function keyframeFindings(document: CssDocument): RuleFinding[] {
  const findings: RuleFinding[] = [];
  for (const keyframes of document.keyframes) {
    for (const step of keyframes.steps) {
      for (const declaration of step.declarations) {
        if (!LAYOUT_PROPERTIES.has(declaration.property)) continue;
        findings.push(layoutFinding(declaration.property, declaration.line));
      }
    }
  }
  return findings;
}

/** The transitions that name a layout property. */
function transitionFindings(document: CssDocument): RuleFinding[] {
  const findings: RuleFinding[] = [];
  for (const block of allBlocks(document)) {
    for (const declaration of block.declarations) {
      if (!isTransition(declaration)) continue;
      for (const part of declaration.value.split(/[\s,]+/)) {
        const property = part.toLowerCase();
        if (!LAYOUT_PROPERTIES.has(property)) continue;
        findings.push(layoutFinding(property, declaration.line));
      }
    }
  }
  return findings;
}

/** The finding of one animated layout property. */
function layoutFinding(property: string, line: number): RuleFinding {
  return {
    line,
    message: `The animation of ${property} lays the page out on every frame.`,
    fix: `Animate transform and opacity instead of ${property}`,
  };
}

/**
 * A page root that clips its overflow.
 *
 * `overflow-x: hidden` on the root hides the content that overflows
 * instead of fixing it, and a width of `100vw` adds the scrollbar to the
 * viewport.
 */
export const overflowClip = defineRule({
  id: 'css/overflow-clip',
  source: 'hallmark:floor-4',
  tier: 'floor',
  appliesTo: CSS_GLOBS,
  waivable: false,
  check: (file) => {
    const findings: RuleFinding[] = [];
    for (const block of allBlocks(scanOf(file))) {
      if (!isPageRoot(block.selector)) continue;
      for (const declaration of block.declarations) {
        const finding = rootFinding(block.selector, declaration);
        if (finding !== undefined) findings.push(finding);
      }
    }
    return findings;
  },
});

/** The finding of a declaration on the page root, or nothing. */
function rootFinding(selector: string, declaration: CssDeclaration): RuleFinding | undefined {
  if (declaration.property === 'overflow-x' || declaration.property === 'overflow') {
    const value =
      declaration.property === 'overflow'
        ? declaration.value.split(/[\s,]+/).find((part) => part !== '')
        : declaration.value;
    if (value === undefined || !/^(hidden|clip)$/i.test(value)) return undefined;
    return {
      line: declaration.line,
      message: `The ${declaration.property} of ${selector} hides the content that overflows.`,
      fix: 'Remove the overflow clip and fix the element that overflows',
    };
  }
  if (declaration.property === 'width' && declaration.value.includes('100vw')) {
    return {
      line: declaration.line,
      message: `The width of ${selector} counts the scrollbar into the viewport.`,
      fix: 'Use width: 100% on the page root instead of 100vw',
    };
  }
  return undefined;
}

/**
 * An image grid track that cannot shrink.
 *
 * A bare `fr` track keeps its automatic minimum, so an image is wider
 * than the track it sits in. The rule looks at the grids that hold
 * images, because that is where the track overflows.
 */
export const gridMinmax = defineRule({
  id: 'css/grid-minmax',
  source: 'hallmark',
  tier: 'reflex',
  appliesTo: CSS_GLOBS,
  waivable: true,
  check: (file) => {
    const findings: RuleFinding[] = [];
    for (const block of allBlocks(scanOf(file))) {
      if (!IMAGE_SELECTOR.test(block.selector)) continue;
      for (const declaration of block.declarations) {
        if (
          declaration.property !== 'grid-template-columns' &&
          declaration.property !== 'grid-auto-columns'
        ) {
          continue;
        }
        if (!hasBareTrack(declaration.value)) continue;
        findings.push({
          line: declaration.line,
          message: `The image track of ${block.selector} keeps its automatic minimum, so the image overflows it.`,
          fix: 'Use minmax(0, 1fr) for the image track',
        });
      }
    }
    return findings;
  },
});

/** The selectors of a grid that holds images. */
const IMAGE_SELECTOR = /img|image|gallery|photo|thumb|figure|picture|avatar/i;

/**
 * An animation with no reduced-motion fallback.
 *
 * A person who asked the system for less motion still gets the
 * animation, and the stylesheet is where that is fixed.
 */
export const reducedMotion = defineRule({
  id: 'css/reduced-motion',
  source: ['hallmark:floor-7', 'antislop:R-32'],
  tier: 'floor',
  appliesTo: CSS_GLOBS,
  waivable: false,
  check: (file) => {
    const document = scanOf(file);
    if (hasReducedMotionFallback(document)) return [];
    const site = firstAnimationSite(document);
    if (site === undefined) return [];
    return [
      {
        line: site,
        message: 'The animation has no prefers-reduced-motion fallback.',
        fix: 'Add a @media (prefers-reduced-motion: reduce) block that turns the animation off',
      },
    ];
  },
});

/** Whether the stylesheet has a reduced-motion block. */
function hasReducedMotionFallback(document: CssDocument): boolean {
  return document.atRules.some((at) => at.name === 'media' && prefersReducedMotion(at.params));
}

/** Whether the parameters ask for less motion. */
function prefersReducedMotion(params: string): boolean {
  const withValue = /prefers-reduced-motion\s*:\s*([a-z-]+)/i.exec(params);
  if (withValue !== null) return withValue[1]?.toLowerCase() === 'reduce';
  return /prefers-reduced-motion\s*\)/i.test(params);
}

/** The line of the first animation of the stylesheet. */
function firstAnimationSite(document: CssDocument): number | undefined {
  let site: number | undefined = document.keyframes[0]?.line;
  for (const block of allBlocks(document)) {
    for (const declaration of block.declarations) {
      if (!isAnimation(declaration)) continue;
      if (site === undefined || declaration.line < site) site = declaration.line;
    }
  }
  return site;
}

/** Whether a declaration starts an animation. */
function isAnimation(declaration: CssDeclaration): boolean {
  const animated = ['animation', 'animation-name', 'transition', 'transition-property'];
  if (!animated.includes(declaration.property)) return false;
  return declaration.value.toLowerCase() !== 'none';
}

/**
 * An interactive selector with no focus-visible style.
 *
 * A keyboard user sees the focus ring of a `:focus` style and a mouse
 * user does not, so the style has to be written for `:focus-visible`.
 */
export const focusVisible = defineRule({
  id: 'css/focus-visible',
  source: 'hallmark:floor-6',
  tier: 'floor',
  appliesTo: CSS_GLOBS,
  waivable: false,
  check: (file) => {
    const blocks = allBlocks(scanOf(file));
    const focusKeys = blocks
      .filter((block) => /:focus-visible/i.test(block.selector))
      .map((block) => selectorKey(block.selector))
      .filter((key) => key !== '');
    const findings: RuleFinding[] = [];
    for (const block of blocks) {
      if (/:focus-visible/i.test(block.selector)) continue;
      if (!INTERACTIVE_SELECTOR.test(block.selector)) continue;
      if (isCovered(selectorKey(block.selector), focusKeys)) continue;
      findings.push({
        line: block.line,
        message: `The interactive selector ${block.selector} has no :focus-visible style.`,
        fix: 'Add a :focus-visible style for the interactive selector',
      });
    }
    return findings;
  },
});

/** The selectors of an element a person can point at. */
const INTERACTIVE_SELECTOR = new RegExp(
  [
    '(?:^|[\\s>+~])(?:a|button|input|select|textarea|summary|option)(?![-\\w])',
    '\\[(?:role|type|tabindex|contenteditable)[\\]=]',
    '\\.(?:btn|button|link|cta|tab|toggle|switch|checkbox|radio|menu-item|nav-item|icon-button|close|dropdown|select|input|field|control)(?![a-z0-9])',
  ].join('|'),
  'i',
);

/** The selector without its pseudo-classes, so two of them can be compared. */
function selectorKey(selector: string): string {
  return selector
    .replace(/::?[a-z-]+(?:\([^)]*\))?/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Whether a focus-visible style covers the selector. */
function isCovered(key: string, focusKeys: readonly string[]): boolean {
  if (key === '') return false;
  return focusKeys.some(
    (focusKey) =>
      focusKey === '*' || focusKey === key || focusKey.includes(key) || key.includes(focusKey),
  );
}

/**
 * A token pair under the WCAG AA ratio.
 *
 * The ratio is computed from the unrounded channels, so a pair that
 * rounds to 4.5:1 but is 4.48:1 is still under the minimum. The pair is a
 * foreground token and a background token of the same scope.
 */
export const contrast = defineRule({
  id: 'css/contrast',
  source: 'antislop:R-25',
  tier: 'floor',
  appliesTo: CSS_GLOBS,
  waivable: false,
  check: (file) => contrastFindings(tokenScopes(scanOf(file))),
});

/** One token of a pair, with the colour it holds. */
interface PairToken {
  name: string;
  token: Token;
  colour: Rgb;
}

/** One token pair under the ratio, and the key that says it is the same pair. */
interface Pair {
  key: string;
  finding: RuleFinding;
}

/** The token pairs of every scope that are under the WCAG AA ratio. */
function contrastFindings(scopes: Map<string, Map<string, Token>>): RuleFinding[] {
  const base = baseScope(scopes);
  const findings: RuleFinding[] = [];
  const seen = new Set<string>();
  for (const tokens of scopes.values()) {
    for (const pair of scopeFindings(base, tokens)) {
      if (seen.has(pair.key)) continue;
      seen.add(pair.key);
      findings.push(pair.finding);
    }
  }
  return findings;
}

/** The token pairs of one scope that are under the WCAG AA ratio. */
function scopeFindings(base: Map<string, Token>, tokens: Map<string, Token>): Pair[] {
  const effective = new Map(base);
  for (const [name, token] of tokens) effective.set(name, token);
  const pairs: Pair[] = [];
  for (const [name, token] of effective) {
    if (!isForegroundToken(name)) continue;
    const foreground = pairToken(name, token);
    if (foreground === undefined) continue;
    pairs.push(...pairFindings(foreground, effective));
  }
  return pairs;
}

/** The pairs of one foreground token with every background token. */
function pairFindings(foreground: PairToken, effective: Map<string, Token>): Pair[] {
  const pairs: Pair[] = [];
  for (const [name, token] of effective) {
    if (!isBackgroundToken(name)) continue;
    const background = pairToken(name, token);
    if (background === undefined) continue;
    const pair = pairFinding(foreground, background);
    if (pair !== undefined) pairs.push(pair);
  }
  return pairs;
}

/** A token and the colour it holds, when it holds an opaque one. */
function pairToken(name: string, token: Token): PairToken | undefined {
  const colour = parseColour(token.value);
  if (colour === undefined || colour.a < 1) return undefined;
  return { name, token, colour };
}

/** The finding of one token pair, when the pair is under the ratio. */
function pairFinding(foreground: PairToken, background: PairToken): Pair | undefined {
  const ratio = contrastRatio(foreground.colour, background.colour);
  if (ratio >= 4.5) return undefined;
  return {
    key: `${foreground.name}|${foreground.token.value}|${background.name}|${background.token.value}`,
    finding: {
      line: foreground.token.line,
      message: `${foreground.name} on ${background.name} is ${ratio.toFixed(2)}:1, under the 4.5:1 of WCAG AA.`,
      fix: `Change ${foreground.name} until it reaches 4.5:1 against ${background.name}`,
    },
  };
}

/** One design token. */
interface Token {
  value: string;
  line: number;
}

/** The tokens of every block, by the block they are in. */
function tokenScopes(document: CssDocument): Map<string, Map<string, Token>> {
  const scopes = new Map<string, Map<string, Token>>();
  for (const block of document.blocks) {
    let tokens = scopes.get(block.selector);
    if (tokens === undefined) {
      tokens = new Map<string, Token>();
      scopes.set(block.selector, tokens);
    }
    for (const declaration of block.declarations) {
      if (!declaration.property.startsWith('--')) continue;
      tokens.set(declaration.property, { value: declaration.value, line: declaration.line });
    }
  }
  return scopes;
}

/** The tokens of the root block, which every other scope builds on. */
function baseScope(scopes: Map<string, Map<string, Token>>): Map<string, Token> {
  for (const [selector, tokens] of scopes) {
    if (selector.split(',').some((part) => part.trim() === ':root')) return tokens;
  }
  return new Map<string, Token>();
}

/** Whether a token holds a foreground. */
function isForegroundToken(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith('--on-')) return true;
  return /(^|-)(text|fg|foreground|ink|content|label|muted)(?:-|$)/.test(lower);
}

/** Whether a token holds a background. */
function isBackgroundToken(name: string): boolean {
  const lower = name.toLowerCase();
  if (isForegroundToken(lower)) return false;
  return /(^|-)(bg|background|surface|canvas|panel|base)(?:-|$)/.test(lower);
}

/**
 * The stock purple-to-blue gradient.
 *
 * It is a taste rule, so it only warns, and the design file can turn it
 * off by naming it.
 */
export const purpleBlueGradient = defineRule({
  id: 'css/purple-blue-gradient',
  source: 'hallmark:floor-11',
  tier: 'finish',
  appliesTo: CSS_GLOBS,
  waivable: true,
  check: (file, ctx) => {
    if (designTurnsOff(ctx.design, 'css/purple-blue-gradient', 'finish')) return [];
    const findings: RuleFinding[] = [];
    for (const block of allBlocks(scanOf(file))) {
      for (const declaration of block.declarations) {
        if (!/gradient\(/i.test(declaration.value)) continue;
        const colours = gradientColours(declaration.value);
        if (!hasPurple(colours) || !hasBlue(colours)) continue;
        findings.push({
          line: declaration.line,
          message: `The gradient of ${block.selector} is the stock purple-to-blue one.`,
          fix: 'Use a design token gradient instead of the stock purple-to-blue one',
        });
      }
    }
    return findings;
  },
});

/** The colours of a gradient. */
function gradientColours(value: string): Rgb[] {
  const colours: Rgb[] = [];
  const found = value.match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\([^)]*\)/gi) ?? [];
  for (const text of found) {
    const colour = parseColour(text);
    if (colour !== undefined) colours.push(colour);
  }
  return colours;
}

/** The lowest hue of a purple. */
const PURPLE_FROM = 250;
/** The highest hue of a purple. */
const PURPLE_TO = 300;
/** The lowest hue of a blue. */
const BLUE_FROM = 190;
/** The highest hue of a blue. */
const BLUE_TO = 250;

function hasPurple(colours: readonly Rgb[]): boolean {
  return colours.some((colour) => {
    const hue = hueOf(colour);
    return hue >= PURPLE_FROM && hue < PURPLE_TO;
  });
}

function hasBlue(colours: readonly Rgb[]): boolean {
  return colours.some((colour) => {
    const hue = hueOf(colour);
    return hue >= BLUE_FROM && hue < BLUE_TO;
  });
}

/** Whether a selector is a token block. */
function isTokenBlock(selector: string): boolean {
  return /:root/.test(selector) || /\btheme\b/i.test(selector);
}

/** Whether a declaration sets a font family. */
function isFontFamily(declaration: CssDeclaration): boolean {
  return declaration.property === 'font-family' || declaration.property === 'font';
}

/** Whether a value takes its value from a token. */
function usesToken(value: string): boolean {
  return /var\(/i.test(value);
}

/** The literal colour of a declaration, or nothing. */
function literalColour(declaration: CssDeclaration): string | undefined {
  const value = maskUrls(declaration.value);
  const hex = HEX_COLOUR.exec(value);
  if (hex !== null) return hex[0];
  const fn = COLOUR_FUNCTION.exec(value);
  if (fn !== null) return fn[0];
  if (!COLOUR_PROPERTIES.has(declaration.property)) return undefined;
  for (const word of value.split(/[^a-z-]+/i)) {
    if (NAMED_COLOURS.has(word.toLowerCase())) return word;
  }
  return undefined;
}

/** A value with the contents of every `url()` taken out. */
function maskUrls(value: string): string {
  return value.replace(/url\([^)]*\)/gi, 'url()');
}

/** Whether a selector is the page root. */
function isPageRoot(selector: string): boolean {
  return selector.split(',').some((part) => /^(?:html|body)$/i.test(part.trim()));
}

/** Whether a grid track is a bare `fr`. */
function hasBareTrack(value: string): boolean {
  for (const part of splitTracks(value)) {
    const lower = part.toLowerCase();
    if (lower.startsWith('minmax(')) continue;
    if (lower.startsWith('repeat(')) {
      const inner = part.slice(part.indexOf('(') + 1, part.lastIndexOf(')'));
      if (hasBareTrack(inner)) return true;
      continue;
    }
    if (/^\d*\.?\d+fr$/.test(lower)) return true;
  }
  return false;
}

/** The parts of a grid track list, with the functions kept whole. */
function splitTracks(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of value) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (depth === 0 && (char === ',' || /\s/.test(char))) {
      if (current !== '') parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current !== '') parts.push(current);
  return parts;
}

/** The CSS rules, in the order they run. */
export const cssRules: QualityRule[] = [
  tokenOnlyColourFont,
  noTransitionAll,
  noLayoutAnimation,
  overflowClip,
  gridMinmax,
  reducedMotion,
  focusVisible,
  contrast,
  purpleBlueGradient,
];
