import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import type { Dirent } from "node:fs"
import { dirname, join, relative } from "node:path"
import { agentId, loadRoles, type Target } from "@openagentsy/core"
import { agentFileName, renderAgent } from "../generate/agent.js"
import { COMMANDS, renderCommand } from "../generate/commands.js"
import { lockEntryFor, lockVariants, readModelLock } from "../generate/lock.js"

export type BuildOptions = {
  root: string
  target: Target
  rolesPath?: string
  lockPath?: string
  outDir?: string
}

export type BuildResult = {
  agents: string[]
  commands: string[]
  skills: string[]
  warnings: string[]
}

async function writeFileAt(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, "utf8")
}

async function copySkills(
  sourceDir: string,
  targetDir: string,
): Promise<{ copied: string[]; warnings: string[] }> {
  const copied: string[] = []
  const warnings: string[] = []

  let entries: Dirent[]
  try {
    entries = await readdir(sourceDir, { withFileTypes: true })
  } catch {
    return { copied, warnings }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillFile = join(sourceDir, entry.name, "SKILL.md")
    try {
      const content = await readFile(skillFile, "utf8")
      await writeFileAt(join(targetDir, entry.name, "SKILL.md"), content)
      copied.push(entry.name)
    } catch {
      warnings.push(`skill "${entry.name}" has no SKILL.md, skipped`)
    }
  }

  return { copied, warnings }
}

export async function runBuild(options: BuildOptions): Promise<BuildResult> {
  const root = options.root
  const rolesPath = options.rolesPath ?? join(root, "roles.yaml")
  const lockPath = options.lockPath ?? join(root, "openagentsy.models.lock.json")
  const outDir = options.outDir ?? join(root, ".opencode")

  const roles = await loadRoles(rolesPath)
  const lock = await readModelLock(lockPath)
  const warnings: string[] = []

  if (!lock) {
    warnings.push(
      `no model lock at ${relative(root, lockPath)}, generated agents inherit the OpenCode default model`,
    )
  }

  const agents: string[] = []
  for (const role of Object.values(roles.roles)) {
    const entry = lockEntryFor(lock, role.name)
    const variants = lockVariants(entry)
    const content = renderAgent(role, roles, {
      target: options.target,
      ...(entry?.model ? { model: entry.model } : {}),
      // V1 agent frontmatter has no variant field, so only V2 can pin one.
      ...(options.target === "v2" && variants.start !== undefined
        ? { modelVariant: variants.start }
        : {}),
      effort: variants,
    })
    const path = join(outDir, "agents", agentFileName(role.name))
    await writeFileAt(path, content)
    agents.push(agentId(role.name))
  }

  const commands: string[] = []
  for (const command of COMMANDS) {
    const path = join(outDir, "commands", `${command.name}.md`)
    await writeFileAt(path, renderCommand(command, options.target))
    commands.push(command.name)
  }

  const skills = await copySkills(
    join(root, "templates", ".opencode", "skills"),
    join(outDir, "skills"),
  )
  warnings.push(...skills.warnings)

  return { agents, commands, skills: skills.copied, warnings }
}
