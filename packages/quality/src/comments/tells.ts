/**
 * The tells.
 *
 * A tell is a shape a comment can have that says nothing: a banner, an
 * end marker, a step of the code written out, a label with no content,
 * a TODO with no task, a JSDoc that repeats the signature. Each tell is
 * a pure function of the text of a comment, and the rules ask the tells
 * what a comment says.
 *
 * The preserve list is asked first, so a comment that explains
 * something is never a finding, and the tells are read in a fixed order
 * so a comment is reported once, by one rule.
 */
import type { SourceFile } from '../rule.js';
import { isPreserved } from './preserve.js';
import { type CommentScan, type JsDocEntry, type SourceComment, scanComments } from './scanner.js';
import { STOP_WORDS, splitWords, stem } from './words.js';

/** The tell a comment carries. */
export type Tell =
  | 'decorative-marker'
  | 'banner-separator'
  | 'step-narration'
  | 'empty-label'
  | 'empty-todo'
  | 'redundant-jsdoc';

/** A comment, and the tell it carries. */
export interface ToldComment {
  /** The comment. */
  comment: SourceComment;
  /** The tell the comment carries. */
  tell: Tell;
}

/** What each tell says, and what a person is told to do about it. */
export const SAYING: Record<Tell, { message: string; fix: string }> = {
  'decorative-marker': {
    message: 'The comment carries a decorative marker.',
    fix: 'Delete the marker from the comment',
  },
  'banner-separator': {
    message: 'The comment is a banner separator, or a section label in capitals.',
    fix: 'Delete the banner, or write the label in sentence case',
  },
  'step-narration': {
    message: 'The comment narrates a step of the code.',
    fix: 'Delete the step narration',
  },
  'empty-label': {
    message: 'The comment is a label that says nothing.',
    fix: 'Say what the code does, instead of the label',
  },
  'empty-todo': {
    message: 'The TODO names no task.',
    fix: 'Name the task in the TODO, or delete the TODO',
  },
  'redundant-jsdoc': {
    message: 'The JSDoc repeats the signature and says nothing more.',
    fix: 'Say what the function does, or delete the JSDoc',
  },
};

/** The scans, by the file they were made from. */
const scans = new WeakMap<SourceFile, CommentScan>();

/** The told comments, by the file they were read from. */
const tolds = new WeakMap<SourceFile, ToldComment[]>();

/** The scan of a file. */
export function scanOf(file: SourceFile): CommentScan {
  const cached = scans.get(file);
  if (cached !== undefined) return cached;
  const scan = scanComments(file.text, file.path);
  scans.set(file, scan);
  return scan;
}

/** The comments of a file, and the tell each one carries. */
export function toldOf(file: SourceFile): ToldComment[] {
  const cached = tolds.get(file);
  if (cached !== undefined) return cached;
  const scan = scanOf(file);
  const jsDocs = new Map<number, JsDocEntry>();
  for (const entry of scan.jsDocs) jsDocs.set(entry.start, entry);
  const told: ToldComment[] = [];
  for (const comment of scan.comments) {
    const tell = tellOf(comment, jsDocs.get(comment.start));
    if (tell === undefined) continue;
    told.push({ comment, tell });
  }
  tolds.set(file, told);
  return told;
}

/**
 * The tell a comment carries, or nothing.
 *
 * The narrow tells come first, so `// END IF` is an end marker and not a
 * label in capitals, and a label in capitals is not an empty label.
 */
export function tellOf(comment: SourceComment, entry: JsDocEntry | undefined): Tell | undefined {
  const text = comment.text;
  if (isPreserved(text)) return undefined;
  if (isEndMarker(text) || hasEmoji(text)) return 'decorative-marker';
  if (isSeparatorRun(text) || isAllCapsLabel(text)) return 'banner-separator';
  if (isStepNarration(text)) return 'step-narration';
  if (isEmptyLabel(text)) return 'empty-label';
  if (isEmptyTodo(text)) return 'empty-todo';
  if (entry !== undefined && isRedundantJsDoc(entry)) return 'redundant-jsdoc';
  return undefined;
}

/** The words an end marker is made of. */
const END_MARKERS = new Set([
  'end',
  'if',
  'for',
  'while',
  'switch',
  'try',
  'catch',
  'finally',
  'function',
  'method',
  'class',
  'region',
  'block',
  'loop',
  'do',
  'else',
  'select',
  'subroutine',
]);

/** Whether a comment is an end marker. */
function isEndMarker(text: string): boolean {
  const match = /^end[\s_-]*(.*)$/.exec(text.trim().toLowerCase());
  if (match === null) return false;
  const rest = (match[1] ?? '').trim();
  return rest === '' || END_MARKERS.has(rest);
}

/**
 * The emoji that decorate a comment.
 *
 * The first is the emoji that are drawn as an emoji on their own, and
 * the second is the ones that are drawn as an emoji when they carry a
 * variation selector. A copyright sign is neither, so a licence header
 * is not a decorated comment.
 */
const EMOJI = /(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F)/u;

/** Whether a comment carries a decorative emoji. */
function hasEmoji(text: string): boolean {
  return EMOJI.test(text);
}

/** The characters a banner is made of. */
const SEPARATORS = '=-*#~_+─—–|.';

/** Whether a comment is a banner separator. */
function isSeparatorRun(text: string): boolean {
  const body = text.replace(/\s+/g, '');
  if (body.length < 3) return false;
  for (const char of body) {
    if (!SEPARATORS.includes(char)) return false;
  }
  return true;
}

/**
 * Whether a comment is a section label in capitals.
 *
 * A label of one word is left alone: a word in capitals is often an
 * acronym, and `// API` says something. A label of two words or more
 * says nothing but where the reader is.
 */
export function isAllCapsLabel(text: string): boolean {
  const words = labelWords(text);
  if (words.length < 2) return false;
  return words.every((word) => /^[A-Z][A-Z]*$/.test(word));
}

/**
 * The labels that say nothing.
 *
 * They name a kind of code instead of saying what the code does, and
 * the signature of the code says the same.
 */
const EMPTY_LABELS = new Set([
  'cleanup',
  'clean up',
  'constants',
  'do the thing',
  'helper',
  'helper function',
  'helper functions',
  'helper method',
  'implementation',
  'initialisation',
  'initialization',
  'logic',
  'main function',
  'main logic',
  'main method',
  'misc',
  'miscellaneous',
  'other stuff',
  'set up',
  'setup',
  'stuff',
  'teardown',
  'utilities',
  'utility function',
  'variable declarations',
  'variables',
]);

/** Whether a comment is a label that says nothing. */
function isEmptyLabel(text: string): boolean {
  if (isAllCapsLabel(text)) return false;
  return EMPTY_LABELS.has(labelOf(text));
}

/** The words of a label, without its punctuation. */
function labelWords(text: string): string[] {
  return text
    .trim()
    .replace(/:$/, '')
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '');
}

/** The text of a label, folded to compare it with the list. */
function labelOf(text: string): string {
  return labelWords(text).join(' ').toLowerCase();
}

/** Whether a comment narrates a step of the code. */
function isStepNarration(text: string): boolean {
  return /^step\s*\d+/i.test(text.trim());
}

/**
 * The words a TODO that names no task holds.
 *
 * A TODO that says "fix" names no task: it says that something is
 * wrong and not what to do about it.
 */
const NO_TASK = new Set([
  '',
  'change',
  'cleanup',
  'clean up',
  'do',
  'done',
  'edit',
  'eventually',
  'fix',
  'fix it',
  'fix this',
  'handle',
  'improve',
  'later',
  'misc',
  'note',
  'pending',
  'refactor',
  'see below',
  'someday',
  'something',
  'stuff',
  'tbd',
  'temp',
  'temporary',
  'to do',
  'todo',
  'update',
  'update this',
  'wip',
  'xxx',
  '???',
]);

/** Whether a comment is a TODO that names no task. */
function isEmptyTodo(text: string): boolean {
  const match = /^todo\b[:\s]*(.*)$/i.exec(text.trim());
  if (match === null) return false;
  const rest = (match[1] ?? '')
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, '');
  return NO_TASK.has(rest);
}

/**
 * Whether a JSDoc only repeats the signature.
 *
 * The words of the comment have to be words of the signature: the name
 * of the declaration, the names of its parameters and the types it
 * takes. A word that is nowhere in the signature means the comment says
 * something, and then it is not a finding.
 */
function isRedundantJsDoc(entry: JsDocEntry): boolean {
  const words = wordsOf([entry.text, ...entry.tags]);
  if (words.length === 0) return false;
  const signature = new Set(entry.signature.map((word) => stem(word)));
  return words.every((word) => signature.has(word));
}

/** The words of a text, without the ones that say nothing. */
function wordsOf(parts: readonly string[]): string[] {
  const words: string[] = [];
  for (const part of parts) {
    for (const word of splitWords(part.replace(/['’]s\b/gi, ''))) {
      if (STOP_WORDS.has(word)) continue;
      words.push(stem(word));
    }
  }
  return words;
}
