import { readFile, stat } from "node:fs/promises"
import { join, relative } from "node:path"
import { parse as parseJsonc } from "jsonc-parser"
import { loadRoles, type Target } from "@openagentsy/core"
import { lockEntryFor, readModelLock } from "../generate/lock.js"
import { detectOpenCode, findSkills, targetForVersion, type FoundSkill, type OpenCodeVersion } from "../opencode.js"
import { PROJECT_CONFIG_NAMES } from "../opencode.js"

export type ConfigReport = {
  path: string | undefined
  exists: boolean
  compactionAuto: unknown
  compactionPrune: unknown
  mcpServers: string[]
  plugins: string[]
}

export type RoleReport = {
  role: string
  agent: string
  model: string
  evidence: string
}

export type BoardReport = {
  root: string
  databasePath: string
  databaseExists: boolean
  leaseSnapshotPath: string
  leaseSnapshotExists: boolean
  leases: number
  auditPath: string
  auditExists: boolean
  auditEntries: number
}

export type PluginReport = {
  path: string
  installed: boolean
  bundlePath: string
  bundleBuilt: boolean
}

export type DoctorReport = {
  opencode: { version: OpenCodeVersion | undefined; target: Target }
  config: ConfigReport
  plugin: PluginReport
  roles: RoleReport[]
  skills: FoundSkill[]
  board: BoardReport
  warnings: string[]
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function listMcpServers(config: Record<string, unknown>): string[] {
  const mcp = asRecord(config["mcp"])
  const servers = asRecord(mcp["servers"])
  const names = new Set([...Object.keys(servers), ...Object.keys(mcp).filter((key) => key !== "servers")])
  return [...names].sort()
}

async function readProjectConfig(root: string): Promise<ConfigReport> {
  for (const name of PROJECT_CONFIG_NAMES) {
    const path = join(root, name)
    let text: string
    try {
      text = await readFile(path, "utf8")
    } catch {
      continue
    }
    const config = asRecord(parseJsonc(text))
    const compaction = asRecord(config["compaction"])
    const plugins = config["plugin"] ?? config["plugins"]
    return {
      path,
      exists: true,
      compactionAuto: compaction["auto"],
      compactionPrune: compaction["prune"],
      mcpServers: listMcpServers(config),
      plugins: Array.isArray(plugins) ? plugins.map(String) : [],
    }
  }

  return {
    path: undefined,
    exists: false,
    compactionAuto: undefined,
    compactionPrune: undefined,
    mcpServers: [],
    plugins: [],
  }
}

async function countAuditLines(path: string): Promise<number> {
  try {
    const text = await readFile(path, "utf8")
    return text.split("\n").filter((line) => line.trim().length > 0).length
  } catch {
    return 0
  }
}

async function readLeaseSnapshot(
  path: string,
): Promise<{ leases: unknown[] } | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
    if (typeof parsed !== "object" || parsed === null) return undefined
    const leases = (parsed as { leases?: unknown[] }).leases
    return Array.isArray(leases) ? { leases } : undefined
  } catch {
    return undefined
  }
}

export async function runDoctor(root: string): Promise<DoctorReport> {
  const warnings: string[] = []
  const version = await detectOpenCode()
  const target: Target = version ? targetForVersion(version) : "v1"

  if (!version) {
    warnings.push("opencode binary not found on PATH, assuming v1 layout")
  }

  const config = await readProjectConfig(root)

  if (config.compactionAuto === true) {
    warnings.push("compaction.auto is true. Magic Context requires compaction to be off.")
  }
  if (config.compactionPrune === true) {
    warnings.push("compaction.prune is true, it removes tool output the Lead still needs.")
  }
  if (!config.exists) {
    warnings.push("no project config found, run: openagentsy setup")
  }
  if (!config.mcpServers.includes("openagentsy")) {
    warnings.push("the openagentsy MCP server is not registered in the project config")
  }

  const roles = await loadRoles(join(root, "roles.yaml"))
  const lock = await readModelLock(join(root, "openagentsy.models.lock.json"))

  const roleReports: RoleReport[] = Object.values(roles.roles).map((role) => {
    const entry = lockEntryFor(lock, role.name)
    return {
      role: role.name,
      agent: `oa-${role.name}`,
      model: entry?.model ?? "default (no lock file)",
      evidence: entry?.evidence
        ? `${entry.evidence.source}${entry.evidence.label ? ` [${entry.evidence.label}]` : ""}`
        : "none",
    }
  })

  if (!lock) {
    warnings.push("no model lock file, run: openagentsy models init")
  }

  const skills = await findSkills(root)
  const stateDir = join(root, ".openagentsy")
  const databasePath = join(stateDir, "board.sqlite")
  const leaseSnapshotPath = join(stateDir, "leases.json")
  const auditPath = join(stateDir, "audit.jsonl")

  const databaseExists = await stat(databasePath).then(
    () => true,
    () => false,
  )

  const leaseSnapshot = await readLeaseSnapshot(leaseSnapshotPath)

  const bundlePath = join(root, "packages", "adapter-opencode", "dist", "index.js")
  const pluginPath = join(root, ".opencode", "plugins", "openagentsy.js")
  const pluginInstalled = await stat(pluginPath).then(
    () => true,
    () => false,
  )
  const bundleBuilt = await stat(bundlePath).then(
    () => true,
    () => false,
  )

  if (!pluginInstalled) {
    warnings.push("the OpenAgentsy plugin is not installed, run: openagentsy setup")
  }

  return {
    opencode: { version, target },
    config,
    plugin: { path: pluginPath, installed: pluginInstalled, bundlePath, bundleBuilt },
    roles: roleReports,
    skills,
    board: {
      root: relative(root, stateDir) || ".openagentsy",
      databasePath,
      databaseExists,
      leaseSnapshotPath,
      leaseSnapshotExists: leaseSnapshot !== undefined,
      leases: leaseSnapshot?.leases.length ?? 0,
      auditPath,
      auditExists: await stat(auditPath).then(
        () => true,
        () => false,
      ),
      auditEntries: await countAuditLines(auditPath),
    },
    warnings,
  }
}

function field(label: string, value: string): string {
  return `  ${label.padEnd(12)}${value}`
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = []

  lines.push("OpenCode")
  if (report.opencode.version) {
    lines.push(field("version", report.opencode.version.raw))
    lines.push(field("target", report.opencode.target))
  } else {
    lines.push(field("version", "not found"))
  }

  lines.push("")
  lines.push("Project config")
  lines.push(field("path", report.config.path ?? "not found"))
  lines.push(
    field(
      "compaction",
      `auto=${String(report.config.compactionAuto ?? "unset")} prune=${String(
        report.config.compactionPrune ?? "unset",
      )}`,
    ),
  )
  lines.push(field("mcp", report.config.mcpServers.join(", ") || "none"))
  lines.push(field("plugins", report.config.plugins.join(", ") || "none"))

  if (report.warnings.length > 0) {
    lines.push("")
    lines.push("Warnings")
    for (const warning of report.warnings) {
      lines.push(`  - ${warning}`)
    }
  }

  lines.push("")
  lines.push("Plugin")
  lines.push(field("installed", report.plugin.installed ? report.plugin.path : "not installed"))
  if (!report.plugin.bundleBuilt) {
    lines.push(field("bundle", "not built, run: pnpm build"))
  }

  lines.push("")
  lines.push("Roles")
  for (const role of report.roles) {
    lines.push(`  ${role.agent.padEnd(14)}${role.model}   (${role.evidence})`)
  }

  lines.push("")
  lines.push("Board")
  lines.push(field("database", `${report.board.databasePath} ${report.board.databaseExists ? "found" : "missing"}`))
  lines.push(
    field(
      "leases",
      `${report.board.leaseSnapshotPath} ${report.board.leases} lease(s)`,
    ),
  )
  lines.push(
    field("audit", `${report.board.auditPath} ${report.board.auditEntries} entries`),
  )

  lines.push("")
  lines.push(`Skills (${report.skills.length} found)`)
  for (const skill of report.skills) {
    lines.push(`  ${skill.name.padEnd(28)}${skill.path}`)
  }

  return `${lines.join("\n")}\n`
}
