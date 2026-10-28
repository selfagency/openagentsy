/**
 * A small CSS scanner.
 *
 * The CSS rules read the text of a stylesheet, and a parser is more than
 * that needs. The scanner finds the blocks, the declarations and the
 * at-rules, with the line each one is on. It is not a CSS parser, and it
 * does not pretend to be one: it reads what the rules ask about and
 * nothing else.
 */

/** One declaration. */
export interface CssDeclaration {
  /** The property, lowercased. */
  property: string;
  /** The value, without the `!important`. */
  value: string;
  /** The 1-based line the declaration starts on. */
  line: number;
  /** Whether the declaration ends with `!important`. */
  important: boolean;
}

/** One rule block: a selector and its declarations. */
export interface CssBlock {
  /** The selector list, as written. */
  selector: string;
  /** The 1-based line the selector starts on. */
  line: number;
  /** The declarations of the block. */
  declarations: CssDeclaration[];
  /** The at-rules around the block, outermost first. */
  atRules: string[];
}

/** One keyframes block, with its steps. */
export interface CssKeyframes {
  /** The name of the animation. */
  name: string;
  /** The 1-based line the at-rule starts on. */
  line: number;
  /** The steps of the animation. */
  steps: CssBlock[];
}

/** One at-rule. */
export interface CssAtRule {
  /** The name, without the `@`. */
  name: string;
  /** The parameters, without the name. */
  params: string;
  /** The 1-based line the at-rule starts on. */
  line: number;
}

/** What a scan of a stylesheet found. */
export interface CssDocument {
  /** Every rule block, including the ones inside an at-rule. */
  blocks: CssBlock[];
  /** Every keyframes block, with its steps. */
  keyframes: CssKeyframes[];
  /** Every at-rule. */
  atRules: CssAtRule[];
}

/** What the scanner is inside of. */
type Frame =
  | {
      kind: 'rule';
      prelude: string;
      line: number;
      declarations: CssDeclaration[];
      atRules: string[];
    }
  | {
      kind: 'at';
      name: string;
      params: string;
      prelude: string;
      line: number;
      children: CssBlock[];
      atRules: string[];
    };

/** What the scanner holds while it walks the stylesheet. */
interface ScanState {
  /** The stylesheet, with its comments blanked out. */
  source: string;
  /** What has been found so far. */
  document: CssDocument;
  /** The blocks that are still open. */
  stack: Frame[];
  /** The text of the selector or the declaration being read. */
  buffer: string;
  /** The line the buffer started on. */
  bufferLine: number;
  /** The line the scanner is on. */
  line: number;
  /** The character the scanner is on. */
  index: number;
}

/**
 * Scan a stylesheet.
 *
 * The comments are blanked out first, so a brace in a comment cannot close
 * a block, and the strings are read as they are, so a brace in a string
 * cannot either.
 */
export function scanCss(text: string): CssDocument {
  const state: ScanState = {
    source: maskComments(text),
    document: { blocks: [], keyframes: [], atRules: [] },
    stack: [],
    buffer: '',
    bufferLine: 1,
    line: 1,
    index: 0,
  };

  while (state.index < state.source.length) {
    const char = state.source[state.index];
    if (char === undefined) break;
    if (char === '\n') {
      nextLine(state);
      continue;
    }
    if (char === '"' || char === "'") {
      readQuoted(state);
      continue;
    }
    if (char === '{') {
      openBlock(state);
      continue;
    }
    if (char === '}') {
      closeBlock(state);
      continue;
    }
    if (char === ';') {
      flush(state);
      state.index += 1;
      continue;
    }
    push(state, char);
    state.index += 1;
  }

  return state.document;
}

/** Every block of a stylesheet, with the steps of its keyframes. */
export function allBlocks(document: CssDocument): CssBlock[] {
  const blocks = [...document.blocks];
  for (const keyframes of document.keyframes) blocks.push(...keyframes.steps);
  return blocks;
}

/** Add text to the buffer, and remember where the buffer started. */
function push(state: ScanState, chunk: string): void {
  if (state.buffer.trim() === '' && chunk.trim() !== '') state.bufferLine = state.line;
  state.buffer += chunk;
}

/** Move to the next line, keeping the newline in the buffer. */
function nextLine(state: ScanState): void {
  state.line += 1;
  push(state, '\n');
  state.index += 1;
}

/** Read a string as it stands, so a brace in it is not a brace. */
function readQuoted(state: ScanState): void {
  const end = readString(state.source, state.index);
  push(state, state.source.slice(state.index, end));
  state.index = end;
}

/** Open a block: a rule, or an at-rule with a body. */
function openBlock(state: ScanState): void {
  const prelude = state.buffer.trim();
  const at = parseAtRule(prelude);
  const atRules = state.stack.filter((frame) => frame.kind === 'at').map((frame) => frame.prelude);
  if (at === undefined) {
    state.stack.push({ kind: 'rule', prelude, line: state.bufferLine, declarations: [], atRules });
  } else {
    state.stack.push({
      kind: 'at',
      name: at.name,
      params: at.params,
      prelude,
      line: state.bufferLine,
      children: [],
      atRules,
    });
    state.document.atRules.push({ ...at, line: state.bufferLine });
  }
  state.buffer = '';
  state.index += 1;
}

/** Close a block, and put it where it belongs. */
function closeBlock(state: ScanState): void {
  flush(state);
  const frame = state.stack.pop();
  if (frame !== undefined) closeFrame(frame, state.stack, state.document);
  state.buffer = '';
  state.index += 1;
}

/** Read the buffer as a declaration, or as an at-rule without a body. */
function flush(state: ScanState): void {
  const text = state.buffer.trim();
  state.buffer = '';
  if (text === '') return;
  const frame = state.stack[state.stack.length - 1];
  if (frame === undefined) {
    const at = parseAtRule(text);
    if (at !== undefined) state.document.atRules.push({ ...at, line: state.bufferLine });
    return;
  }
  if (frame.kind !== 'rule') return;
  const declaration = parseDeclaration(text, state.bufferLine);
  if (declaration !== undefined) frame.declarations.push(declaration);
}

/** Close a block and put it where it belongs. */
function closeFrame(frame: Frame, stack: Frame[], document: CssDocument): void {
  if (frame.kind === 'rule') {
    const block: CssBlock = {
      selector: frame.prelude,
      line: frame.line,
      declarations: frame.declarations,
      atRules: frame.atRules,
    };
    const parent = stack[stack.length - 1];
    if (parent !== undefined && parent.kind === 'at') parent.children.push(block);
    if (parent === undefined || parent.kind !== 'at' || !isKeyframes(parent)) {
      document.blocks.push(block);
    }
    return;
  }
  if (isKeyframes(frame)) {
    document.keyframes.push({ name: frame.params, line: frame.line, steps: frame.children });
  }
}

/** Whether an at-rule holds the steps of an animation. */
function isKeyframes(frame: Frame): boolean {
  return frame.kind === 'at' && /keyframes$/i.test(frame.name);
}

/** The name and the parameters of an at-rule. */
function parseAtRule(prelude: string): { name: string; params: string } | undefined {
  if (!prelude.startsWith('@')) return undefined;
  const rest = prelude.slice(1).trim();
  const space = rest.search(/\s/);
  if (space === -1) return { name: rest.toLowerCase(), params: '' };
  return { name: rest.slice(0, space).toLowerCase(), params: rest.slice(space + 1).trim() };
}

/** One declaration of a block. */
function parseDeclaration(text: string, line: number): CssDeclaration | undefined {
  const colon = text.indexOf(':');
  if (colon === -1) return undefined;
  const property = text.slice(0, colon).trim().toLowerCase();
  if (property === '') return undefined;
  let value = text.slice(colon + 1).trim();
  const important = /!\s*important$/i.test(value);
  if (important) value = value.replace(/!\s*important$/i, '').trim();
  return { property, value, line, important };
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

/**
 * The stylesheet with its comments blanked out.
 *
 * The comment keeps its newlines, so the line numbers of the rest of the
 * file do not move.
 */
function maskComments(text: string): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '/' && text[index + 1] === '*') {
      const stop = commentEnd(text, index);
      out += blank(text.slice(index, stop));
      index = stop;
      continue;
    }
    if (char === '"' || char === "'") {
      const end = readString(text, index);
      out += text.slice(index, end);
      index = end;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/** The index after the comment that starts at `start`. */
function commentEnd(text: string, start: number): number {
  const end = text.indexOf('*/', start + 2);
  return end === -1 ? text.length : end + 2;
}

/** A text with everything but its newlines blanked out. */
function blank(text: string): string {
  return text.replace(/[^\n]/g, ' ');
}
