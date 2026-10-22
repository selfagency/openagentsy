import { execFile } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { Target } from '@openagentsy/core';

const execFileAsync = promisify(execFile);

export type OpenCodeVersion = {
  binary: string;
  raw: string;
  major: number;
  minor: number;
  patch: number;
};

export async function detectOpenCode(): Promise<OpenCodeVersion | undefined> {
  try {
    const { stdout } = await execFileAsync('opencode', ['--version'], { timeout: 10_000 });
    const raw = stdout.trim();
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(raw);
    if (!match) return undefined;
    return {
      binary: 'opencode',
      raw,
      major: Number(match[1]),
      minor: Number(match[2]),
      patch: Number(match[3]),
    };
  } catch {
    return undefined;
  }
}

export function targetForVersion(version: OpenCodeVersion): Target {
  return version.major >= 2 ? 'v2' : 'v1';
}

/** Project config file names, in the order OpenCode prefers them. */
export const PROJECT_CONFIG_NAMES = ['opencode.json', 'opencode.jsonc'] as const;

/**
 * Directories that hold skills, in the order OpenCode searches them. The
 * first skill found with a given name wins, so a user-level skill can
 * silently shape every project. `openagentsy doctor` prints where each skill
 * came from for exactly that reason.
 */
function skillSearchDirs(startDir: string): string[] {
  const dirs: string[] = [];

  let current = startDir;
  for (let depth = 0; depth < 10; depth += 1) {
    dirs.push(join(current, '.opencode', 'skills'));
    dirs.push(join(current, '.claude', 'skills'));
    dirs.push(join(current, '.agents', 'skills'));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  dirs.push(join(homedir(), '.config', 'opencode', 'skills'));
  dirs.push(join(homedir(), '.claude', 'skills'));
  dirs.push(join(homedir(), '.agents', 'skills'));

  return dirs;
}

export type FoundSkill = {
  name: string;
  path: string;
  source: string;
};

/**
 * Find every skill OpenCode could load, and where it came from. The first
 * match for a name wins, matching OpenCode's own resolution order.
 */
export async function findSkills(startDir: string): Promise<FoundSkill[]> {
  const seen = new Set<string>();
  const found: FoundSkill[] = [];

  for (const dir of skillSearchDirs(startDir)) {
    const entries = await readDirSafe(dir);
    if (!entries) continue;
    for (const entry of entries) {
      const skill = skillOfEntry(dir, entry, seen);
      if (skill) {
        seen.add(skill.name);
        found.push(skill);
      }
    }
  }

  return found;
}

/** The directory's entries, or nothing when the directory is not there. */
async function readDirSafe(dir: string): Promise<Dirent[] | undefined> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
}

/**
 * The skill one directory entry names, or nothing when the entry is not a
 * skill or its name is already taken.
 */
function skillOfEntry(dir: string, entry: Dirent, seen: Set<string>): FoundSkill | undefined {
  if (entry.isDirectory()) {
    if (seen.has(entry.name)) return undefined;
    return { name: entry.name, path: join(dir, entry.name, 'SKILL.md'), source: dir };
  }
  // V2 also accepts a flat skills/<name>.md file.
  if (!entry.isFile() || !entry.name.endsWith('.md')) return undefined;
  const name = entry.name.replace(/\.md$/, '');
  if (seen.has(name)) return undefined;
  return { name, path: join(dir, entry.name), source: dir };
}
