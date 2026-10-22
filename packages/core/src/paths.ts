import { isAbsolute, relative, sep } from 'node:path';

/**
 * Convert a glob to a regular expression.
 *
 * `**` crosses path separators, `*` and `?` do not. Everything else is
 * literal. The same shape OpenCode uses for its own path-scoped permissions,
 * so a lease glob and an edit permission glob mean the same thing.
 */
export function globToRegExp(pattern: string): RegExp {
  const chars = [...pattern];
  let out = '';

  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i];

    if (char === undefined) break;

    if (char === '*') {
      const isDoubleStar = chars[i + 1] === '*';
      if (!isDoubleStar) {
        out += '[^/]*';
        continue;
      }
      i += 1;
      if (chars[i + 1] === '/') {
        i += 1;
        out += '(?:.*/)?';
      } else {
        out += '.*';
      }
      continue;
    }

    if (char === '?') {
      out += '[^/]';
      continue;
    }

    out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }

  return new RegExp(`^${out}$`);
}

export function matchesGlob(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(normalizePath(path));
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
