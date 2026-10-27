import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The project's OpenAgentsy config.
 *
 * `openagentsy.jsonc` is the file the Phase 2 keys live in (§13), and the
 * one this bridge needs is `hooks.approvalFor`: the commands a person has
 * to approve. The file is written by a person, so it may carry comments and
 * a trailing comma.
 *
 * The reader is here rather than a dependency because the plugin is bundled
 * into one self-contained file, and a second JSON parser in that bundle is
 * a second parser to keep in step.
 */

/** The name of the project's config file. */
const PROJECT_CONFIG_NAME = 'openagentsy.jsonc';

/**
 * The end of a string, the closing quote included.
 *
 * A backslash escapes the next character, so an escaped quote does not end
 * the string.
 */
function readString(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === '"') return index + 1;
    index += 1;
  }
  return index;
}

/** The first character after a line comment. */
function skipLineComment(text: string, start: number): number {
  const end = text.indexOf('\n', start);
  return end === -1 ? text.length : end;
}

/** The first character after a block comment. */
function skipBlockComment(text: string, start: number): number {
  const end = text.indexOf('*/', start + 2);
  return end === -1 ? text.length : end + 2;
}

/**
 * Whether the comma at an index is a trailing one.
 *
 * A trailing comma is a comma before a closing brace or bracket, and
 * JSONC allows it while JSON does not.
 */
function isTrailingComma(text: string, index: number): boolean {
  let ahead = index + 1;
  while (ahead < text.length && /\s/.test(text[ahead] ?? '')) ahead += 1;
  const following = text[ahead];
  return following === '}' || following === ']';
}

/**
 * Strip the comments and the trailing commas of a JSONC file.
 *
 * A comment marker inside a string is text, so the scanner reads the
 * strings first: a URL in a config is not a comment.
 */
function stripJsonc(text: string): string {
  const out: string[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? '';
    if (char === '"') {
      const end = readString(text, index);
      out.push(text.slice(index, end));
      index = end;
      continue;
    }
    if (char === '/' && text[index + 1] === '/') {
      index = skipLineComment(text, index);
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      index = skipBlockComment(text, index);
      continue;
    }
    if (char === ',' && isTrailingComma(text, index)) {
      index += 1;
      continue;
    }
    out.push(char);
    index += 1;
  }
  return out.join('');
}

/**
 * The commands the project asks a person to approve.
 *
 * A project without the file, or with a file that holds no approval list,
 * asks for nothing: the answer is an empty list rather than a guess. A file
 * that is not JSON is not a config this bridge can read, so it asks for
 * nothing as well.
 */
export async function readApprovalFor(root: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(join(root, PROJECT_CONFIG_NAME), 'utf8');
  } catch {
    // A project that has no config file has no approval list. That is not a
    // failure: the file is optional.
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(text));
  } catch {
    // A config that cannot be read asks for nothing. The person who wrote it
    // is the one who can fix it, and the plugin is not the place to guess.
    return [];
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
  const hooks = (parsed as { hooks?: unknown }).hooks;
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return [];
  const approvalFor = (hooks as { approvalFor?: unknown }).approvalFor;
  if (!Array.isArray(approvalFor)) return [];
  return approvalFor.filter((entry): entry is string => typeof entry === 'string');
}
