import type { Dirent } from 'node:fs';
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { agentIdOf, loadRoles, type RolesFile, type Target } from '@openagentsy/core';
import { agentFileName, renderAgent } from '../generate/agent.js';
import { COMMANDS, renderCommand } from '../generate/commands.js';
import { lockEntryFor, lockVariants, type ModelLock, readModelLock } from '../generate/lock.js';

export type BuildOptions = {
  root: string;
  target: Target;
  rolesPath?: string;
  lockPath?: string;
  outDir?: string;
};

export type BuildResult = {
  agents: string[];
  commands: string[];
  skills: string[];
  warnings: string[];
};

async function writeFileAt(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

/**
 * Remove the agent files a previous build wrote that this one does not.
 *
 * The `oa-` prefix is the generated naming scheme, so a file that carries it
 * and is not in the current set is a role that was renamed or removed. A file
 * without the prefix is not ours, so it is left alone.
 */
async function removeStaleAgents(agentsDir: string, current: Set<string>): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(agentsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith('oa-')) continue;
    if (current.has(entry.name.replace(/\.md$/, ''))) continue;
    await unlink(join(agentsDir, entry.name));
  }
}

async function copySkills(
  sourceDir: string,
  targetDir: string,
): Promise<{ copied: string[]; warnings: string[] }> {
  const copied: string[] = [];
  const warnings: string[] = [];

  let entries: Dirent[];
  try {
    entries = await readdir(sourceDir, { withFileTypes: true });
  } catch {
    return { copied, warnings };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = join(sourceDir, entry.name, 'SKILL.md');
    try {
      const content = await readFile(skillFile, 'utf8');
      await writeFileAt(join(targetDir, entry.name, 'SKILL.md'), content);
      copied.push(entry.name);
    } catch {
      warnings.push(`skill "${entry.name}" has no SKILL.md, skipped`);
    }
  }

  return { copied, warnings };
}

/**
 * Render every role's agent file, and return the ids that were written.
 */
async function renderAgents(
  roles: RolesFile,
  lock: ModelLock | undefined,
  target: Target,
  agentsDir: string,
): Promise<string[]> {
  const ids: string[] = [];
  for (const role of Object.values(roles.roles)) {
    const entry = lockEntryFor(lock, role.name);
    const variants = lockVariants(entry);
    const content = renderAgent(role, roles, {
      target,
      ...(entry?.model ? { model: entry.model } : {}),
      // V1 agent frontmatter has no variant field, so only V2 can pin one.
      ...(target === 'v2' && variants.start !== undefined ? { modelVariant: variants.start } : {}),
      effort: variants,
    });
    await writeFileAt(join(agentsDir, agentFileName(role)), content);
    ids.push(agentIdOf(role));
  }
  return ids;
}

export async function runBuild(options: BuildOptions): Promise<BuildResult> {
  const root = options.root;
  const rolesPath = options.rolesPath ?? join(root, 'roles.yaml');
  const lockPath = options.lockPath ?? join(root, 'openagentsy.models.lock.json');
  const outDir = options.outDir ?? join(root, '.opencode');

  const roles = await loadRoles(rolesPath);
  const lock = await readModelLock(lockPath);
  const warnings: string[] = [];

  if (!lock) {
    warnings.push(
      `no model lock at ${relative(root, lockPath)}, generated agents inherit the OpenCode default model`,
    );
  }

  const agents = await renderAgents(roles, lock, options.target, join(outDir, 'agents'));
  await removeStaleAgents(join(outDir, 'agents'), new Set(agents));

  const commands: string[] = [];
  for (const command of COMMANDS) {
    const path = join(outDir, 'commands', `${command.name}.md`);
    await writeFileAt(path, renderCommand(command, options.target));
    commands.push(command.name);
  }

  const skills = await copySkills(
    join(root, 'templates', '.opencode', 'skills'),
    join(outDir, 'skills'),
  );
  warnings.push(...skills.warnings);

  return { agents, commands, skills: skills.copied, warnings };
}
