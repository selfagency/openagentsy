import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { CheckCtx, Finding, QualityRegistry, SourceFile } from './rule.js';
import { qualityRegistry } from './rules.js';

/**
 * The check: the rules of the registry, run over a set of files.
 *
 * A rule reads the text of a file, so the check reads the files from the
 * disk. A file that cannot be read is skipped: it was deleted, or it was
 * never there, and there is nothing to say about a file that is not there.
 */

/** How the text of a file is read. */
export type FileReader = (path: string) => Promise<string | undefined>;

/** What the check needs besides the paths and the context. */
export interface CheckOptions {
  /** The directory a relative path is read from. */
  root?: string;
  /** The rules the check runs. */
  registry?: QualityRegistry;
  /** How the text of a file is read. */
  read?: FileReader;
}

/**
 * The findings of a set of paths.
 *
 * The paths are the ones a call touched, and the findings are the ones the
 * rules that apply to those paths report. The path of a finding is the path
 * as it was given, because that is the path the agent knows.
 */
export async function check(
  paths: readonly string[],
  ctx: CheckCtx = {},
  options: CheckOptions = {},
): Promise<Finding[]> {
  const registry = options.registry ?? qualityRegistry;
  const read = options.read ?? readFromDisk;
  const findings: Finding[] = [];
  for (const path of paths) {
    const text = await read(absolute(options.root, path));
    if (text === undefined) continue;
    const file: SourceFile = { path, text };
    for (const rule of registry.forFile(path)) {
      findings.push(...rule.check(file, ctx));
    }
  }
  return findings;
}

/** The text of a file, when it can be read. */
async function readFromDisk(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** The path the reader is given. */
function absolute(root: string | undefined, path: string): string {
  if (root === undefined || isAbsolute(path)) return path;
  return join(root, path);
}
