/**
 * The copy of a page.
 *
 * The copy rules read the strings a person sees, and not the strings a
 * person does not: the code, the comments, the markup and the prose of a
 * document are not copy. This module says which strings are copy, and
 * where each one is.
 */

import {
  type MarkupAttribute,
  type MarkupDocument,
  type MarkupKind,
  type MarkupNode,
  textLine,
} from './scanner.js';

/** One piece of copy a person reads. */
export interface CopyText {
  /** The text, as it is written. */
  text: string;
  /** The 1-based line the text starts on. */
  line: number;
  /** The element the text is in, when it is in one. */
  element?: MarkupNode | undefined;
  /** The ancestors of the element, from the root down to its parent. */
  ancestors: MarkupNode[];
  /** The attribute the text came from, when it came from one. */
  attribute?: string | undefined;
}

/** The attributes whose value a person reads. */
const COPY_ATTRIBUTES = new Set([
  'title',
  'alt',
  'placeholder',
  'label',
  'aria-label',
  'aria-description',
]);

/** The elements whose content is not copy. */
const NOT_COPY = new Set(['script', 'style', 'code', 'pre', 'svg', 'textarea']);

/**
 * The copy of a document.
 *
 * The text of an element is copy, and so is the value of the attributes a
 * person reads: the title of a link, the alternative of a picture, the
 * hint in a field. The content of a script, a style, a code block, a
 * preformatted block, an inline picture or a text area is not.
 */
export function copyOf(document: MarkupDocument): CopyText[] {
  const found: CopyText[] = [];
  collect(document.root, [], document.kind, found);
  return found;
}

/** Walk the tree, and take the copy out of it. */
function collect(
  node: MarkupNode,
  ancestors: MarkupNode[],
  kind: MarkupKind,
  found: CopyText[],
): void {
  for (const child of node.children) {
    if (child.kind === 'text') {
      addCopy(found, textCopy(child, node, ancestors, kind));
      continue;
    }
    if (child.kind === 'comment') continue;
    const childAncestors = [...ancestors, node];
    addAttributes(found, child, childAncestors);
    if (NOT_COPY.has(child.name)) continue;
    collect(child, childAncestors, kind, found);
  }
}

/** Add a piece of copy to the list, when there is one. */
function addCopy(found: CopyText[], text: CopyText | undefined): void {
  if (text === undefined) return;
  found.push(text);
}

/**
 * The copy a text node holds, when it holds some.
 *
 * The text outside an element of a JSX file is code, so it is not copy.
 */
function textCopy(
  child: MarkupNode,
  parent: MarkupNode,
  ancestors: MarkupNode[],
  kind: MarkupKind,
): CopyText | undefined {
  if (parent.name === '#document' && kind === 'jsx') return undefined;
  if (!isCopy(child.text)) return undefined;
  return {
    text: child.text.trim(),
    line: textLine(child.line, child.text),
    element: parent.name === '#document' ? undefined : parent,
    ancestors,
  };
}

/** Add the copy the attributes of an element hold. */
function addAttributes(found: CopyText[], element: MarkupNode, ancestors: MarkupNode[]): void {
  for (const held of element.attributes) {
    addCopy(found, attributeText(held, element, ancestors));
  }
}

/** The copy one attribute holds, when it holds some. */
function attributeText(
  held: MarkupAttribute,
  element: MarkupNode,
  ancestors: MarkupNode[],
): CopyText | undefined {
  if (held.value === undefined) return undefined;
  if (!COPY_ATTRIBUTES.has(held.name.toLowerCase())) return undefined;
  if (!isCopy(held.value)) return undefined;
  return {
    text: held.value.trim(),
    line: textLine(held.line, held.value),
    element,
    ancestors,
    attribute: held.name,
  };
}

/** Whether a piece of text holds something a person reads. */
function isCopy(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}
