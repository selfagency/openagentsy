/**
 * The fixes.
 *
 * A finding carries the instruction: what a person is told to do, in
 * one line. The mechanical rewrite is a separate artifact, because a
 * rewrite of a comment is more than one line: it is a range of the
 * file and the text that takes its place. `applyCommentFix` puts a
 * rewrite in the file and proves that it changed nothing but the
 * comments.
 */
import type { SourceFile } from '../rule.js';
import { astEqualIgnoringComments, parseFile } from './ast.js';
import type { SourceComment } from './scanner.js';
import { SAYING, type Tell, type ToldComment, toldOf } from './tells.js';

/** A rewrite of one comment. */
export interface CommentFix {
  /** The rule that produced the fix. */
  ruleId: string;
  /** The path of the file the fix belongs to. */
  path: string;
  /**
   * The 0-based range the fix replaces, from `start` to `end`.
   *
   * The range is an offset into the text the fixes were made from, so
   * more than one fix is applied from the last to the first: a fix
   * moves the offsets of the fixes after it.
   */
  range: { start: number; end: number };
  /** The text that takes the place of the range. */
  replacement: string;
  /** The instruction, in the imperative. */
  instruction: string;
}

/** The rule of each tell. */
const RULE_OF: Record<Tell, string> = {
  'banner-separator': 'comment/banner-separator',
  'decorative-marker': 'comment/decorative-marker',
  'step-narration': 'comment/step-narration',
  'empty-label': 'comment/empty-label',
  'empty-todo': 'comment/empty-todo',
  'redundant-jsdoc': 'comment/redundant-jsdoc',
};

/**
 * The tells that have a mechanical rewrite.
 *
 * A TODO that names no task has none: the marker says that there is
 * work to do, and deleting it would drop that. The task has to be
 * named, and only a person knows what it is. Every other tell is a
 * comment that says nothing the code does not already say, and the
 * rewrite takes it out.
 */
const REWRITABLE: readonly Tell[] = [
  'banner-separator',
  'decorative-marker',
  'step-narration',
  'empty-label',
  'redundant-jsdoc',
];

/**
 * The mechanical rewrites of the comments of a file.
 *
 * The ranges are the offsets of the text of the file, so the fixes are
 * applied from the last to the first.
 */
export function commentFixes(file: SourceFile): CommentFix[] {
  const fixes: CommentFix[] = [];
  for (const told of toldOf(file)) {
    if (!REWRITABLE.includes(told.tell)) continue;
    fixes.push(fixOf(file, told));
  }
  return fixes;
}

/** The rewrite of one comment. */
function fixOf(file: SourceFile, told: ToldComment): CommentFix {
  return {
    ruleId: RULE_OF[told.tell],
    path: file.path,
    range: deletionRange(file.text, told.comment),
    replacement: '',
    instruction: SAYING[told.tell].fix,
  };
}

/**
 * Put a rewrite in the file.
 *
 * A rewrite may only touch comment trivia. Anything else is a bug in
 * the rule, not a judgment call, so the two programs are compared and
 * the rewrite is refused when it changed the code.
 */
export function applyCommentFix(src: string, fix: CommentFix): string {
  const out = splice(src, fix.range, fix.replacement);
  if (!astEqualIgnoringComments(parseFile(src, fix.path), parseFile(out, fix.path))) {
    throw new Error(`comment fix ${fix.ruleId} changed code`);
  }
  return out;
}

/** The text with a range replaced. */
function splice(src: string, range: { start: number; end: number }, replacement: string): string {
  return src.slice(0, range.start) + replacement + src.slice(range.end);
}

/**
 * The range a deletion of a comment covers.
 *
 * A comment that stands on a line of its own takes the line with it,
 * and a comment that sits beside the code is taken out on its own.
 */
function deletionRange(text: string, comment: SourceComment): { start: number; end: number } {
  const lineStart = comment.start <= 0 ? 0 : text.lastIndexOf('\n', comment.start - 1) + 1;
  const lineEnd = text.indexOf('\n', comment.end);
  const end = lineEnd === -1 ? text.length : lineEnd;
  const before = text.slice(lineStart, comment.start);
  const after = text.slice(comment.end, end);
  if (before.trim() === '' && after.trim() === '') {
    return { start: lineStart, end: lineEnd === -1 ? text.length : lineEnd + 1 };
  }
  return { start: comment.start, end: comment.end };
}
