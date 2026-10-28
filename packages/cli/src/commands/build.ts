import type { Dirent } from 'node:fs';
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { agentIdFor, agentIdOf, loadRoles, type RolesFile } from '@openagentsy/core';
import { agentFileName, renderAgent } from '../generate/agent.js';
import { COMMANDS, renderCommand } from '../generate/commands.js';
import { lockEntryFor, lockVariants, type ModelLock, readModelLock } from '../generate/lock.js';

export type BuildOptions = {
  root: string;
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

async function writeFileAt(path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

/**
 * Remove the agent files a previous build wrote that this one does not.
 *
 * A file the build wrote is one whose name carries the agent prefix, or one
 * whose name is the agent name of a role in the roles file. A role may name
 * its own agent, and that name does not carry the prefix, so a role that was
 * renamed or removed leaves its file behind unless the name is looked up in
 * the roles file as well.
 *
 * A file that is neither is not ours, so it is left alone.
 */
async function removeStaleAgents(
  agentsDir: string,
  current: Set<string>,
  knownNames: Set<string>,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(agentsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.md')) continue;
    const name = entry.name.replace(/\.md$/, '');
    if (current.has(name)) continue;
    if (!name.startsWith('oa-') && !knownNames.has(name)) continue;
    await unlink(join(agentsDir, entry.name));
  }
}

/**
 * Copy a directory, with everything in it.
 *
 * A skill may link to reference files beside its SKILL.md, and a copy
 * that took only the SKILL.md would leave those links pointing at
 * nothing. The whole tree is copied, so a file the skill names is
 * there when the skill is read.
 */
async function copyTree(from: string, to: string): Promise<void> {
  const entries = await readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) {
      await mkdir(target, { recursive: true });
      await copyTree(source, target);
      continue;
    }
    await writeFileAt(target, await readFile(source));
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
    const skillDir = join(sourceDir, entry.name);
    try {
      await readFile(join(skillDir, 'SKILL.md'), 'utf8');
    } catch {
      warnings.push(`skill "${entry.name}" has no SKILL.md, skipped`);
      continue;
    }
    try {
      await copyTree(skillDir, join(targetDir, entry.name));
    } catch (error) {
      warnings.push(`skill "${entry.name}" could not be copied: ${(error as Error).message}`);
      continue;
    }
    copied.push(entry.name);
  }

  return { copied, warnings };
}

/**
 * Render every role's agent file, and return the ids that were written.
 */
async function renderAgents(
  roles: RolesFile,
  lock: ModelLock | undefined,
  agentsDir: string,
): Promise<string[]> {
  const ids: string[] = [];
  for (const role of Object.values(roles.roles)) {
    const entry = lockEntryFor(lock, role.name);
    const variants = lockVariants(entry);
    const content = renderAgent(role, roles, {
      ...(entry?.model ? { model: entry.model } : {}),
      // The agent frontmatter pins the variant of the model it starts on.
      ...(variants.start !== undefined ? { modelVariant: variants.start } : {}),
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

  const agents = await renderAgents(roles, lock, join(outDir, 'agents'));
  const knownNames = new Set(
    Object.values(roles.roles)
      .map((role) => role.agentName)
      .filter((name): name is string => name !== undefined),
  );
  await removeStaleAgents(join(outDir, 'agents'), new Set(agents), knownNames);

  const commands: string[] = [];
  for (const command of COMMANDS) {
    const path = join(outDir, 'commands', `${command.name}.md`);
    await writeFileAt(path, renderCommand(command, agentIdFor(roles, command.role)));
    commands.push(command.name);
  }

  const skills = await copySkills(
    join(root, 'templates', '.opencode', 'skills'),
    join(outDir, 'skills'),
  );
  warnings.push(...skills.warnings);

  return { agents, commands, skills: skills.copied, warnings };
}
