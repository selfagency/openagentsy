/**
 * A small markup scanner.
 *
 * The HTML and copy rules read the structure of a page, and a parser is
 * more than that needs. The scanner finds the elements, the attributes, the
 * text and the comments, with the line each one is on. It is not an HTML
 * parser, and it does not pretend to be one: it reads what the rules ask
 * about and nothing else.
 *
 * Two kinds of file are read. An HTML file is read as HTML: a comment is
 * `<!-- -->`, a tag starts with a letter, and the content of a `script` or
 * a `style` is not markup. A JSX file is read as JSX: a comment lives
 * inside an expression, a tag cannot follow an identifier (that would be a
 * type argument), and the text of an element can hold an expression.
 */

/** What a file of markup is. */
export type MarkupKind = 'html' | 'jsx';

/** One attribute of an element. */
export interface MarkupAttribute {
  /** The name, as written. */
  name: string;
  /** The value, when the attribute has one that is text. */
  value?: string | undefined;
  /** True when the value is an expression, so it is not text. */
  expression?: boolean | undefined;
  /** The 1-based line the attribute is on. */
  line: number;
}

/** One node of the tree. */
export interface MarkupNode {
  /** What the node is. */
  kind: 'element' | 'text' | 'comment';
  /** The tag name, lowercased. Empty for a text node and for a comment. */
  name: string;
  /** The attributes of an element. */
  attributes: MarkupAttribute[];
  /** The text of a text node, the body of a comment. */
  text: string;
  /** The children of the node. */
  children: MarkupNode[];
  /** The 1-based line the node starts on. */
  line: number;
}

/** What a scan of a file found. */
export interface MarkupDocument {
  /** The kind of markup the file holds. */
  kind: MarkupKind;
  /** The root of the tree. Its name is `#document`. */
  root: MarkupNode;
}

/** The elements whose content is not markup. */
const RAW_TEXT = new Set(['script', 'style', 'textarea']);

/** The characters a JSX tag can follow. */
const JSX_BEFORE = /[\s({[,;=?:&|!+\-*/%^~>)\]]/;

/** The characters a JSX tag cannot follow, because they close a string. */
const STRING_END = new Set(['"', "'", '`']);

/** The state the scanner holds while it walks the file. */
interface ScanState {
  /** The file, as it was handed over. */
  text: string;
  /** The kind of markup the file holds. */
  kind: MarkupKind;
  /** The character the scanner is on. */
  index: number;
  /** The line the scanner is on. */
  line: number;
  /** The elements that are still open. */
  stack: MarkupNode[];
}

/** Where a tag starts, so the line of a thing in it can be counted. */
interface TagOrigin {
  /** The index of the `<`. */
  index: number;
  /** The line the `<` is on. */
  line: number;
}

/** The attributes of a tag, and where the tag ends. */
interface TagAttributes {
  /** The attributes, in the order they are written. */
  attributes: MarkupAttribute[];
  /** The index after the tag. */
  index: number;
  /** True when the tag closes itself. */
  selfClosing: boolean;
}

/** The value of an attribute, and where the attribute ends. */
interface AttributeValue {
  /** The value, when the attribute has one that is text. */
  value?: string | undefined;
  /** True when the value is an expression, so it is not text. */
  expression: boolean;
  /** The index after the attribute. */
  index: number;
}

/**
 * Scan a file of markup.
 *
 * The tree holds the elements, their attributes, the text between them and
 * the comments. Every node carries the line it starts on, so a rule can
 * point at the line a person has to change.
 */
export function scanMarkup(text: string, kind: MarkupKind): MarkupDocument {
  const root: MarkupNode = {
    kind: 'element',
    name: '#document',
    attributes: [],
    text: '',
    children: [],
    line: 1,
  };
  const state: ScanState = { text, kind, index: 0, line: 1, stack: [root] };
  while (state.index < state.text.length) {
    if (readMarkup(state)) continue;
    readText(state);
  }
  return { kind, root };
}

/**
 * Read a tag, a comment or a declaration.
 *
 * It says whether it read something: a `<` that opens nothing is text, and
 * the text reader takes it from there.
 */
function readMarkup(state: ScanState): boolean {
  if (state.text[state.index] !== '<') return false;
  if (state.text.startsWith('<!--', state.index)) {
    readComment(state);
    return true;
  }
  if (state.text.startsWith('</', state.index) && isCloseTagStart(state, state.index)) {
    readCloseTag(state);
    return true;
  }
  if (state.text.startsWith('<!', state.index) || state.text.startsWith('<?', state.index)) {
    readDeclaration(state);
    return true;
  }
  if (!isOpenTagStart(state, state.index)) return false;
  readOpenTag(state);
  return true;
}

/** The value of an attribute, by name, whatever the case. */
export function attribute(node: MarkupNode, name: string): string | undefined {
  for (const held of node.attributes) {
    if (held.name.toLowerCase() === name.toLowerCase()) return held.value;
  }
  return undefined;
}

/** Whether an element carries an attribute, whatever the case. */
export function hasAttribute(node: MarkupNode, name: string): boolean {
  return node.attributes.some((held) => held.name.toLowerCase() === name.toLowerCase());
}

/** The class names of an element, lowercased. */
export function classNames(node: MarkupNode): string[] {
  const value = attribute(node, 'class');
  if (value === undefined) return [];
  return value
    .split(/\s+/)
    .filter((name) => name !== '')
    .map((name) => name.toLowerCase());
}

/** An element, with the ancestors it has. */
export interface ElementWithAncestors {
  /** The element. */
  node: MarkupNode;
  /** The ancestors of the element, from the root down to its parent. */
  ancestors: MarkupNode[];
}

/** Every element of the tree, with the ancestors it has. */
export function elementsWithAncestors(root: MarkupNode): ElementWithAncestors[] {
  const found: ElementWithAncestors[] = [];
  const walk = (node: MarkupNode, ancestors: MarkupNode[]): void => {
    for (const child of node.children) {
      if (child.kind !== 'element') continue;
      found.push({ node: child, ancestors });
      walk(child, [...ancestors, child]);
    }
  };
  walk(root, []);
  return found;
}

/** The number of newlines in a piece of text. */
export function countNewlines(text: string): number {
  let count = 0;
  for (const char of text) {
    if (char === '\n') count += 1;
  }
  return count;
}

/**
 * The line a match is on.
 *
 * The text starts on `line`, so the line of a match is the line of the
 * text plus the newlines that come before the match.
 */
export function lineAt(line: number, text: string, offset: number): number {
  return line + countNewlines(text.slice(0, offset));
}

/**
 * The line the text of a node is on.
 *
 * The text of an element often starts with a line break, so the line of
 * the text is the line of its first character that is not white space.
 */
export function textLine(line: number, text: string): number {
  const at = text.search(/\S/u);
  if (at === -1) return line;
  return lineAt(line, text, at);
}

/** Read the text between two tags. */
function readText(state: ScanState): void {
  let buffer = '';
  let index = state.index;
  while (index < state.text.length) {
    const char = state.text[index];
    if (char === undefined) break;
    if (char === '<') {
      if (isMarkupStart(state, index)) break;
      buffer += char;
      index += 1;
      continue;
    }
    if (char === '{' && state.kind === 'jsx' && state.stack.length > 1) {
      const end = matchBrace(state.text, index);
      // The newlines of the expression are kept, so the line of the text
      // after it is still the line it is on.
      buffer += '\n'.repeat(countNewlines(state.text.slice(index, end)));
      index = end;
      continue;
    }
    buffer += char;
    index += 1;
  }
  if (buffer !== '') pushText(state, buffer);
  state.index = index;
  state.line += countNewlines(buffer);
}

/** Add a text node to the element that is open. */
function pushText(state: ScanState, text: string): void {
  const parent = state.stack[state.stack.length - 1];
  if (parent === undefined) return;
  const last = parent.children[parent.children.length - 1];
  if (last !== undefined && last.kind === 'text') {
    last.text += text;
    return;
  }
  parent.children.push({
    kind: 'text',
    name: '',
    attributes: [],
    text,
    children: [],
    line: state.line,
  });
}

/** Read a comment, from `<!--` to `-->`. */
function readComment(state: ScanState): void {
  const start = state.index;
  const startLine = state.line;
  const end = state.text.indexOf('-->', start + 4);
  const body = state.text.slice(start + 4, end === -1 ? state.text.length : end);
  const stop = end === -1 ? state.text.length : end + 3;
  state.index = stop;
  state.line = startLine + countNewlines(state.text.slice(start, stop));
  const parent = state.stack[state.stack.length - 1];
  if (parent === undefined) return;
  parent.children.push({
    kind: 'comment',
    name: '',
    attributes: [],
    text: body,
    children: [],
    line: startLine,
  });
}

/** Read a doctype or a processing instruction, and skip it. */
function readDeclaration(state: ScanState): void {
  const start = state.index;
  const end = state.text.indexOf('>', start);
  const stop = end === -1 ? state.text.length : end + 1;
  state.index = stop;
  state.line += countNewlines(state.text.slice(start, stop));
}

/** Read a closing tag, and close the element it names. */
function readCloseTag(state: ScanState): void {
  const start = state.index;
  let index = state.index + 2;
  const nameStart = index;
  while (index < state.text.length && !/[\s>]/.test(state.text[index] ?? '')) index += 1;
  const name = state.text.slice(nameStart, index).toLowerCase();
  while (index < state.text.length && state.text[index] !== '>') index += 1;
  if (index < state.text.length) index += 1;
  state.index = index;
  state.line += countNewlines(state.text.slice(start, index));
  for (let depth = state.stack.length - 1; depth >= 1; depth -= 1) {
    const open = state.stack[depth];
    if (open === undefined) break;
    if (open.name === name) {
      state.stack.length = depth;
      break;
    }
  }
}

/** Read an opening tag, its attributes, and the element it opens. */
function readOpenTag(state: ScanState): void {
  const origin: TagOrigin = { index: state.index, line: state.line };
  const named = readTagName(state.text, origin.index + 1);
  const read = readAttributes(state, named.index, origin);
  const element: MarkupNode = {
    kind: 'element',
    name: named.name,
    attributes: read.attributes,
    text: '',
    children: [],
    line: origin.line,
  };
  const parent = state.stack[state.stack.length - 1];
  if (parent !== undefined) parent.children.push(element);
  state.index = read.index;
  state.line += countNewlines(state.text.slice(origin.index, read.index));
  if (read.selfClosing) return;
  state.stack.push(element);
  if (!RAW_TEXT.has(element.name)) return;
  skipRawText(state, element.name, read.index);
}

/** The name of a tag, and the index after it. */
function readTagName(text: string, from: number): { name: string; index: number } {
  const read = readUntil(text, from, /[\s/>]/);
  const name = read.text === '' ? '#fragment' : read.text.toLowerCase();
  return { name, index: read.index };
}

/**
 * The text that ends at one of the characters, and the index after it.
 *
 * A name, an attribute value and the white space before a value are all
 * read the same way: the run of characters that ends at a delimiter.
 */
function readUntil(text: string, from: number, stop: RegExp): { text: string; index: number } {
  let index = from;
  while (index < text.length && !stop.test(text[index] ?? '')) index += 1;
  return { text: text.slice(from, index), index };
}

/** The attributes of a tag, and where the tag ends. */
function readAttributes(state: ScanState, from: number, origin: TagOrigin): TagAttributes {
  const attributes: MarkupAttribute[] = [];
  let index = from;
  let selfClosing = false;
  while (index < state.text.length) {
    const end = tagEnd(state.text, index);
    if (end !== 0) {
      selfClosing = state.text[index] === '/';
      index += end;
      break;
    }
    const char = state.text[index] ?? '';
    if (/\s/.test(char) || char === '/') {
      index += 1;
      continue;
    }
    const read = readAttribute(state, index, origin);
    if (read.attribute === undefined) {
      index += 1;
      continue;
    }
    attributes.push(read.attribute);
    index = read.index;
  }
  return { attributes, index, selfClosing };
}

/**
 * The end of a tag at an index.
 *
 * It is the number of characters the end takes: one for the `>` that
 * closes the tag, two for the `/>` that closes the element as well. Zero
 * means the tag goes on.
 */
function tagEnd(text: string, index: number): number {
  if (text[index] === '>') return 1;
  if (text[index] === '/' && text[index + 1] === '>') return 2;
  return 0;
}

/** One attribute of a tag, and where the attribute ends. */
function readAttribute(
  state: ScanState,
  from: number,
  origin: TagOrigin,
): { attribute?: MarkupAttribute; index: number } {
  const named = readUntil(state.text, from, /[\s=>/]/);
  if (named.text === '') return { index: from + 1 };
  const read = readAttributeValue(state, named.index);
  return {
    attribute: {
      name: named.text,
      value: read.value,
      expression: read.expression,
      line: origin.line + countNewlines(state.text.slice(origin.index, from)),
    },
    index: read.index,
  };
}

/** Skip the content of a script, a style or a textarea, which is not markup. */
function skipRawText(state: ScanState, name: string, from: number): void {
  const at = indexOfIgnoreCase(state.text, `</${name}`, from);
  const stop = at === -1 ? state.text.length : at;
  state.index = stop;
  state.line += countNewlines(state.text.slice(from, stop));
}

/** The value of an attribute, and where the attribute ends. */
function readAttributeValue(state: ScanState, from: number): AttributeValue {
  const afterSpace = skipSpace(state.text, from);
  if (state.text[afterSpace] !== '=') return { expression: false, index: afterSpace };
  const start = skipSpace(state.text, afterSpace + 1);
  const quote = state.text[start];
  if (quote === '"' || quote === "'") return readQuotedValue(state.text, start, quote);
  if (quote === '{') return { expression: true, index: matchBrace(state.text, start) };
  return readBareValue(state.text, start);
}

/** The index after the white space at an index. */
function skipSpace(text: string, from: number): number {
  return readUntil(text, from, /\S/).index;
}

/** The value of a quoted attribute, and where the attribute ends. */
function readQuotedValue(text: string, from: number, quote: string): AttributeValue {
  const end = text.indexOf(quote, from + 1);
  const stop = end === -1 ? text.length : end;
  return {
    value: text.slice(from + 1, stop),
    expression: false,
    index: end === -1 ? text.length : end + 1,
  };
}

/** The value of an attribute with no quotes, and where the attribute ends. */
function readBareValue(text: string, from: number): AttributeValue {
  const read = readUntil(text, from, /[\s>]/);
  return { value: read.text, expression: false, index: read.index };
}

/** Whether a tag starts at an index. */
function isMarkupStart(state: ScanState, index: number): boolean {
  if (state.text.startsWith('<!--', index)) return true;
  if (state.text.startsWith('</', index)) return isCloseTagStart(state, index);
  if (state.text.startsWith('<!', index) || state.text.startsWith('<?', index)) return true;
  return isOpenTagStart(state, index);
}

/** Whether an opening tag starts at an index. */
function isOpenTagStart(state: ScanState, index: number): boolean {
  const next = state.text[index + 1];
  if (next === undefined) return false;
  if (state.kind === 'html') return /[a-z]/i.test(next);
  if (next === '>') return true;
  if (!/[a-z]/i.test(next)) return false;
  const before = index > 0 ? state.text[index - 1] : undefined;
  if (before === undefined) return true;
  if (STRING_END.has(before)) return false;
  return JSX_BEFORE.test(before);
}

/** Whether a closing tag starts at an index. */
function isCloseTagStart(state: ScanState, index: number): boolean {
  if (state.kind === 'html') return true;
  const before = index > 0 ? state.text[index - 1] : undefined;
  if (before === undefined) return true;
  return !STRING_END.has(before);
}

/** The index after the brace that matches the one at `start`. */
function matchBrace(text: string, start: number): number {
  let depth = 0;
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (char === '{') {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      index += 1;
      if (depth === 0) return index;
      continue;
    }
    if (char !== undefined && STRING_END.has(char)) {
      index = readString(text, index);
      continue;
    }
    index += 1;
  }
  return text.length;
}

/** The index after the string that starts at `start`. */
function readString(text: string, start: number): number {
  const quote = text[start];
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === quote) return index + 1;
    index += 1;
  }
  return text.length;
}

/** The index of a text, whatever the case, from a start. */
function indexOfIgnoreCase(text: string, needle: string, from: number): number {
  return text.toLowerCase().indexOf(needle.toLowerCase(), from);
}
