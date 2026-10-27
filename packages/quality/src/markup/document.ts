/**
 * The file-kind boundary.
 *
 * The rules read pages and components, and they do not read documents: a
 * `.md` file is prose, and prose is never copy. The boundary is the file
 * kind, because a file's kind is the one thing a rule can be sure of.
 */

import type { SourceFile } from '../rule.js';
import { type MarkupDocument, type MarkupKind, scanMarkup } from './scanner.js';

/** The file kinds that hold a page. */
const PAGE_FILES = ['.html', '.htm', '.vue', '.svelte'];

/** The file kinds that hold a component. */
const COMPONENT_FILES = ['.tsx', '.jsx'];

/**
 * The kind of markup a file holds.
 *
 * Nothing, when the file holds no markup: a stylesheet, a script, a
 * document.
 */
export function markupKindOf(path: string): MarkupKind | undefined {
  const lower = path.toLowerCase();
  if (PAGE_FILES.some((extension) => lower.endsWith(extension))) return 'html';
  if (COMPONENT_FILES.some((extension) => lower.endsWith(extension))) return 'jsx';
  return undefined;
}

/**
 * The scan of a file.
 *
 * Eight rules read the same file, so the scan is kept and the second rule
 * to ask for it gets the first one's answer. A file is read as it was
 * when it was handed over.
 */
const documents = new WeakMap<SourceFile, MarkupDocument>();

/** The scan of a file, when the file holds markup. */
export function markupOf(file: SourceFile): MarkupDocument | undefined {
  const kind = markupKindOf(file.path);
  if (kind === undefined) return undefined;
  const cached = documents.get(file);
  if (cached !== undefined) return cached;
  const document = scanMarkup(file.text, kind);
  documents.set(file, document);
  return document;
}
