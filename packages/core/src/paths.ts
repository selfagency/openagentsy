import { isAbsolute, relative, sep } from 'node:path';

/**
 * Path matching.
 *
 * A lease glob is written by an agent, and it is matched against every path
 * the guard sees. A glob is therefore untrusted input, and the matcher cannot
 * be a regular expression: a pattern like `*a*a*a*a*a*a*b` compiles to a
 * backtracking expression, and a long path that nearly matches costs
 * exponential time. The matcher below walks the pattern and the path once, in
 * linear time, whatever the pattern says.
 */

/** One piece of a glob. */
export type GlobToken =
  | { kind: 'literal'; text: string }
  /** A single star, which stays inside one path segment. */
  | { kind: 'star' }
  /** A double star, which crosses path separators. */
  | { kind: 'any' }
  /** A double star with a separator, which is any number of whole segments. */
  | { kind: 'segments' }
  /** A question mark, which is one character that is not a separator. */
  | { kind: 'one' };

/** The longest a glob may be. A longer one is a mistake, not a pattern. */
export const MAX_GLOB_LENGTH = 512;

/**
 * Cut a glob into its pieces.
 *
 * The shape is the one OpenCode uses for its own path-scoped permissions, so
 * a lease glob and an edit permission glob mean the same thing: a double
 * star crosses path separators, a single star and a question mark do not, and
 * everything else is literal.
 */
export function tokenizeGlob(pattern: string): GlobToken[] {
  const tokens: GlobToken[] = [];
  const chars = [...pattern];
  let literal = '';

  const flush = (): void => {
    if (literal.length > 0) {
      tokens.push({ kind: 'literal', text: literal });
      literal = '';
    }
  };

  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i];
    if (char === undefined) break;

    if (char === '*') {
      if (chars[i + 1] === '*') {
        flush();
        i += 1;
        if (chars[i + 1] === '/') {
          i += 1;
          tokens.push({ kind: 'segments' });
        } else {
          tokens.push({ kind: 'any' });
        }
        continue;
      }
      flush();
      tokens.push({ kind: 'star' });
      continue;
    }

    if (char === '?') {
      flush();
      tokens.push({ kind: 'one' });
      continue;
    }

    literal += char;
  }

  flush();
  return tokens;
}

/**
 * Whether the tokens match the path.
 *
 * The table records what each pair of positions can still match, so every
 * pair is worked out once. The cost is the product of the two lengths, not
 * the number of ways the pattern can be split.
 */
function matchTokens(tokens: GlobToken[], path: string): boolean {
  const rows = tokens.length + 1;
  const columns = path.length + 1;
  const table: boolean[][] = [];
  for (let row = 0; row < rows; row += 1) {
    const cells: boolean[] = [];
    for (let column = 0; column < columns; column += 1) cells.push(false);
    table.push(cells);
  }

  // The empty pattern matches the empty path.
  const lastRow = table[rows - 1];
  if (lastRow !== undefined) lastRow[columns - 1] = true;

  for (let tokenIndex = rows - 2; tokenIndex >= 0; tokenIndex -= 1) {
    const token = tokens[tokenIndex];
    if (token === undefined) continue;
    const row = table[tokenIndex];
    const next = table[tokenIndex + 1];
    if (row === undefined || next === undefined) continue;

    for (let pathIndex = columns - 1; pathIndex >= 0; pathIndex -= 1) {
      row[pathIndex] = tokenMatches(token, next, path, pathIndex, columns);
    }
  }

  return table[0]?.[0] === true;
}

/**
 * Whether one token matches the path from one position.
 *
 * The rest of the pattern is `next`, so a token matches when what follows it
 * matches the path that is left.
 */
function tokenMatches(
  token: GlobToken,
  next: boolean[],
  path: string,
  pathIndex: number,
  columns: number,
): boolean {
  if (token.kind === 'literal') {
    return path.startsWith(token.text, pathIndex) && next[pathIndex + token.text.length] === true;
  }
  if (token.kind === 'one') {
    const char = path[pathIndex];
    return char !== undefined && char !== '/' && next[pathIndex + 1] === true;
  }
  if (token.kind === 'star') {
    return starMatches(next, path, pathIndex, columns);
  }
  if (token.kind === 'any') {
    return anyMatches(next, pathIndex, columns);
  }
  return segmentsMatch(next, path, pathIndex, columns);
}

/**
 * A single star takes the rest of the segment, or nothing at all.
 */
function starMatches(next: boolean[], path: string, pathIndex: number, columns: number): boolean {
  for (let end = pathIndex; end <= columns - 1; end += 1) {
    if (next[end] === true) return true;
    const char = path[end];
    if (char === undefined || char === '/') return false;
  }
  return false;
}

/**
 * A double star takes everything, separators included.
 */
function anyMatches(next: boolean[], pathIndex: number, columns: number): boolean {
  for (let end = pathIndex; end <= columns - 1; end += 1) {
    if (next[end] === true) return true;
  }
  return false;
}

/**
 * Any number of whole segments: nothing, or a run that ends in a separator.
 */
function segmentsMatch(next: boolean[], path: string, pathIndex: number, columns: number): boolean {
  if (next[pathIndex] === true) return true;
  for (let end = pathIndex; end < columns - 1; end += 1) {
    if (path[end] === '/' && next[end + 1] === true) return true;
  }
  return false;
}

/**
 * Whether a path matches a glob.
 *
 * A glob longer than the limit matches nothing. A lease with such a glob
 * covers no file, which is the safe answer.
 */
export function matchesGlob(pattern: string, path: string): boolean {
  if (pattern.length > MAX_GLOB_LENGTH) return false;
  return matchTokens(tokenizeGlob(pattern), normalizePath(path));
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/**
 * Express a path relative to the project root. Paths outside the root keep
 * their absolute form so a lease can never match by accident.
 */
export function relativeToRoot(root: string, target: string): string {
  const rel = relative(root, target);
  if (rel === '') return '';
  if (rel.startsWith('..')) return normalizePath(target);
  return normalizePath(rel);
}

/**
 * True when the target sits inside the root. A path that escapes the root
 * through `..` is outside it, so a broad lease glob cannot swallow it.
 */
export function isInsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  return !rel.startsWith('..');
}

export function toPosix(path: string): string {
  return path.split(sep).join('/');
}
