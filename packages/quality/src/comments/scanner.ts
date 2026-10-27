/**
 * The comments of a source file.
 *
 * The compiler hands out the comment ranges of a file, and the lint
 * reads them: a comment in a string is not a comment, and a comment in
 * a JSX text is not one either. The ranges are the compiler's, and the
 * lines are counted from one.
 */
import ts from 'typescript';
import { parseFile, tokenNodes } from './ast.js';
import { splitWords } from './words.js';

/** One comment of a file. */
export interface SourceComment {
  /** The text of the comment, without the markers. */
  text: string;
  /** The 0-based offset the comment starts at. */
  start: number;
  /** The 0-based offset after the comment. */
  end: number;
  /** The 1-based line the comment starts on. */
  line: number;
  /** Whether the comment is a block comment. */
  block: boolean;
  /** Whether the comment is a JSDoc block. */
  jsDoc: boolean;
}

/** A JSDoc comment, and the declaration it documents. */
export interface JsDocEntry {
  /** The 0-based offset the comment starts at. */
  start: number;
  /** The 1-based line the comment starts on. */
  line: number;
  /** The prose of the comment. */
  text: string;
  /** The description of every tag of the comment. */
  tags: readonly string[];
  /** The name of the declaration the comment documents. */
  name: string;
  /** The words of the signature of the declaration. */
  signature: readonly string[];
}

/** What a scan of a file found. */
export interface CommentScan {
  /** Every comment of the file, in the order they appear. */
  comments: SourceComment[];
  /** The JSDoc comments, with the declaration each one documents. */
  jsDocs: JsDocEntry[];
}

/** Scan the comments of a file. */
export function scanComments(text: string, path: string): CommentScan {
  const file = parseFile(text, path);
  return { comments: commentsOf(text, file), jsDocs: jsDocsOf(text, file) };
}

/**
 * The comments of a file, by the ranges the compiler hands out.
 *
 * A comment is the trivia of a token, so the walk over the tokens finds
 * every comment of the file: the one before a statement, the one after
 * it, and the one that hangs before a closing brace.
 */
function commentsOf(text: string, file: ts.SourceFile): SourceComment[] {
  const ranges = new Map<string, ts.CommentRange>();
  for (const token of tokenNodes(file)) {
    for (const range of ts.getLeadingCommentRanges(text, token.pos) ?? []) {
      ranges.set(`${range.pos}:${range.end}`, range);
    }
    for (const range of ts.getTrailingCommentRanges(text, token.end) ?? []) {
      ranges.set(`${range.pos}:${range.end}`, range);
    }
  }
  return [...ranges.values()].sort((a, b) => a.pos - b.pos).map((range) => commentOf(text, range));
}

/** The comment of a range. */
function commentOf(text: string, range: ts.CommentRange): SourceComment {
  const raw = text.slice(range.pos, range.end);
  const block = range.kind === ts.SyntaxKind.MultiLineCommentTrivia;
  return {
    text: bodyOf(raw, block),
    start: range.pos,
    end: range.end,
    line: lineAt(text, range.pos),
    block,
    jsDoc: block && raw.startsWith('/**') && !raw.startsWith('/**/'),
  };
}

/** The text of a comment, without its markers. */
function bodyOf(raw: string, block: boolean): string {
  if (!block) return raw.replace(/^\/\//, '');
  return raw.replace(/^\/\*+/, '').replace(/\*+\/$/, '');
}

/** The 1-based line an offset is on. */
function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let at = 0; at < offset; at += 1) {
    if (text.charCodeAt(at) === 10) line += 1;
  }
  return line;
}

/**
 * The JSDoc comments of a file, with the declaration each one documents.
 *
 * A JSDoc comment belongs to the declaration that follows it, and the
 * declaration says what its signature is. The walk visits the
 * declaration before the parts of it, so a comment is read with the
 * declaration it documents.
 */
function jsDocsOf(text: string, file: ts.SourceFile): JsDocEntry[] {
  const entries: JsDocEntry[] = [];
  const seen = new Set<number>();
  const visit = (node: ts.Node): void => {
    // A source file hands out the JSDoc of its first statement, so the
    // walk asks the statements and not the file: the comment belongs to
    // the declaration it documents.
    if (!ts.isSourceFile(node)) {
      for (const doc of ts.getJSDocCommentsAndTags(node)) {
        if (!isJsDoc(doc)) continue;
        if (seen.has(doc.pos)) continue;
        seen.add(doc.pos);
        const entry = jsDocEntry(text, file, doc, node);
        if (entry !== undefined) entries.push(entry);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return entries;
}

/** Whether a node is a JSDoc comment and not one of its tags. */
function isJsDoc(node: ts.Node): node is ts.JSDoc {
  return node.kind === ts.SyntaxKind.JSDoc;
}

/** The entry of a JSDoc comment. */
function jsDocEntry(
  text: string,
  file: ts.SourceFile,
  doc: ts.JSDoc,
  node: ts.Node,
): JsDocEntry | undefined {
  const signature = signatureOf(node, file);
  if (signature === undefined) return undefined;
  return {
    start: doc.pos,
    line: lineAt(text, doc.pos),
    text: textOf(doc.comment),
    tags: (doc.tags ?? []).map((tag) => textOf(tag.comment)),
    name: signature.name,
    signature: signature.words,
  };
}

/** The text of a JSDoc comment, or of one of its tags. */
function textOf(comment: string | ts.NodeArray<ts.JSDocComment> | undefined): string {
  if (comment === undefined) return '';
  if (typeof comment === 'string') return comment;
  return comment.map((part) => part.text).join('');
}

/** The name and the words of the signature of a declaration. */
interface Signature {
  name: string;
  words: string[];
}

/** The signature of a declaration, when the declaration has one. */
function signatureOf(node: ts.Node, file: ts.SourceFile): Signature | undefined {
  const name = nameOf(node, file);
  if (name === '') return undefined;
  return { name, words: [...splitWords(name), ...parameterWords(node, file)] };
}

/** The name of a declaration, when it has one. */
function nameOf(node: ts.Node, file: ts.SourceFile): string {
  if (ts.isVariableStatement(node)) {
    const declaration = node.declarationList.declarations[0];
    return declaration === undefined ? '' : declaration.name.getText(file);
  }
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node)
  ) {
    return node.name === undefined ? '' : node.name.getText(file);
  }
  return '';
}

/** The words of the parameters and of the return type of a declaration. */
function parameterWords(node: ts.Node, file: ts.SourceFile): string[] {
  const callable = callableOf(node);
  if (callable === undefined) return [];
  const words: string[] = [];
  for (const parameter of callable.parameters) {
    words.push(...splitWords(parameter.name.getText(file)));
    if (parameter.type !== undefined) words.push(...splitWords(parameter.type.getText(file)));
  }
  if (callable.type !== undefined) words.push(...splitWords(callable.type.getText(file)));
  return words;
}

/** The function a declaration holds, when it holds one. */
function callableOf(node: ts.Node): ts.SignatureDeclaration | undefined {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  ) {
    return node;
  }
  if (ts.isVariableStatement(node)) {
    const initializer = node.declarationList.declarations[0]?.initializer;
    if (
      initializer !== undefined &&
      (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
    ) {
      return initializer;
    }
  }
  return undefined;
}
