import { readFile, stat, writeFile, mkdir, copyFile } from "node:fs/promises"
import { join } from "node:path"
import { applyEdits, modify, type FormattingOptions } from "jsonc-parser"
import type { Target } from "@openagentsy/core"
import { PROJECT_CONFIG_NAMES } from "../opencode.js"

export type SetupOptions = {
  root: string
  target: Target
  configPath?: string
  dryRun?: boolean
}

export type SetupResult = {
  configPath: string
  content: string
  changed: string[]
  pluginPath?: string
  dryRun: boolean
}

const FORMATTING: FormattingOptions = {
  insertSpaces: true,
  tabSize: 2,
  eol: "\n",
}

function setPath(text: string, path: (string | number)[], value: unknown): string {
  const edits = modify(text, path, value, { formattingOptions: FORMATTING })
  return applyEdits(text, edits)
}

async function resolveMcpCommand(root: string): Promise<string[]> {
  const dist = join(root, "packages", "mcp", "dist", "index.js")
  const built = await stat(dist).then(
    () => true,
    () => false,
  )
  if (built) {
    // A relative path keeps the config portable. The MCP server runs with the
    // project directory as its working directory, so it resolves the same way
    // on every machine.
    return ["node", join("packages", "mcp", "dist", "index.js")]
  }
  return ["npx", "-y", "@openagentsy/mcp"]
}

async function findConfigPath(root: string): Promise<string> {
  for (const name of PROJECT_CONFIG_NAMES) {
    const path = join(root, name)
    const exists = await stat(path).then(
      () => true,
      () => false,
    )
    if (exists) return path
  }
  return join(root, "opencode.json")
}

/**
 * Write the config shape OpenCode needs for OpenAgentsy.
 *
 * The two versions disagree on three things this touches: the MCP server
 * lives under `mcp` in V1 and `mcp.servers` in V2, the enable flag is
 * `enabled` in V1 and `disabled` in V2, and V2 turns Code Mode on by default
 * so the board tools have to be listed directly with `codemode: false`.
 */
export async function runSetup(options: SetupOptions): Promise<SetupResult> {
  const configPath = options.configPath ?? (await findConfigPath(options.root))
  const command = await resolveMcpCommand(options.root)

  let text = ""
  try {
    text = await readFile(configPath, "utf8")
  } catch {
    text = ""
  }

  const changed: string[] = []
  let content = text

  if (options.target === "v1") {
    content = setPath(content, ["mcp", "openagentsy"], {
      type: "local",
      command,
      enabled: true,
    })
    changed.push("mcp.openagentsy")
    content = setPath(content, ["compaction", "auto"], false)
    changed.push("compaction.auto")
    content = setPath(content, ["compaction", "prune"], false)
    changed.push("compaction.prune")
  } else {
    content = setPath(content, ["mcp", "servers", "openagentsy"], {
      type: "local",
      command,
      disabled: false,
      codemode: false,
    })
    changed.push("mcp.servers.openagentsy")
    content = setPath(content, ["compaction", "auto"], false)
    changed.push("compaction.auto")
  }

  if (!options.dryRun) {
    await writeFile(configPath, content.endsWith("\n") ? content : `${content}\n`, "utf8")
  }

  const pluginPath = await installPlugin(options.root, options.dryRun ?? false)

  return {
    configPath,
    content,
    changed,
    ...(pluginPath !== undefined ? { pluginPath } : {}),
    dryRun: options.dryRun ?? false,
  }
}

/**
 * Install the OpenCode plugin.
 *
 * The plugin is a self contained bundle, because a plugin file is loaded from
 * the config directory where bare imports do not resolve, and the plugin
 * runtime has no sqlite module.
 */
async function installPlugin(root: string, dryRun: boolean): Promise<string | undefined> {
  const source = join(root, "packages", "adapter-opencode", "dist", "index.js")
  const built = await stat(source).then(
    () => true,
    () => false,
  )
  if (!built) return undefined

  const target = join(root, ".opencode", "plugins", "openagentsy.js")
  if (!dryRun) {
    await mkdir(join(root, ".opencode", "plugins"), { recursive: true })
    await copyFile(source, target)
  }
  return target
}
