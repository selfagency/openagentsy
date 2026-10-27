/**
 * The TypeScript compiler, and what the lint reads with it.
 *
 * The comment lint reads the comments of a file the way the compiler
 * sees them: a `//` inside a string is not a comment, and a URL inside
 * a JSX text is not one either. The compiler hands out the comment
 * ranges, so no second parser is needed.
 */
import ts from 'typescript';

/** The printer that leaves the comments out. */
const printer = ts.createPrinter({ removeComments: true });

/**
 * The kind of source a path holds.
 *
 * The kind decides how the compiler reads the file: a `.tsx` file holds
 * JSX, and a `.js` file holds JavaScript.
 */
export function scriptKindOf(path: string): ts.ScriptKind {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs'))
    return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** Parse a file the way its path says it is written. */
export function parseFile(text: string, path: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKindOf(path));
}

/**
 * Whether two programs are the same, apart from their comments.
 *
 * The check compares the two parsed programs, not the two texts: the
 * code of the file before a fix and the code of the file after it have
 * to be the same program, with the comments taken out. The printed
 * form catches a changed operator or a changed literal, and the tokens
 * catch what the printer normalises.
 */
export function astEqualIgnoringComments(a: ts.SourceFile, b: ts.SourceFile): boolean {
  return printed(a) === printed(b) && sameTokens(tokensOf(a), tokensOf(b));
}

/** The program of a file, printed without its comments. */
function printed(file: ts.SourceFile): string {
  return printer.printFile(file);
}

/** The tokens of a file, one string each. */
export function tokensOf(file: ts.SourceFile): string[] {
  return tokenNodes(file).map((token) => `${token.kind}:${token.getText(file)}`);
}

/** Whether two lists of tokens are the same. */
function sameTokens(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((token, at) => token === b[at]);
}

/**
 * The token nodes of a file.
 *
 * A token knows the trivia that comes before it, and the trivia holds
 * the comments, so the comments of a file are the ones its tokens
 * carry. A comment that hangs before a closing brace is the trivia of
 * that brace, and the walk finds it.
 */
export function tokenNodes(file: ts.SourceFile): ts.Node[] {
  const tokens: ts.Node[] = [];
  const walk = (node: ts.Node): void => {
    for (const child of node.getChildren()) {
      if (isTokenNode(child)) tokens.push(child);
      walk(child);
    }
  };
  walk(file);
  return tokens;
}

/** Whether a node is a token. */
function isTokenNode(node: ts.Node): boolean {
  return node.kind >= ts.SyntaxKind.FirstToken && node.kind <= ts.SyntaxKind.LastToken;
}
