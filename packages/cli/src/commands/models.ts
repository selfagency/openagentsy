import { join } from "node:path"
import { createInterface } from "node:readline/promises"
import { loadRoles } from "@openagentsy/core"
import {
  LOCK_FILE_NAME,
  readLock,
  selectModels,
  writeLock,
  type ModelLock,
  type ProviderSelection,
} from "@openagentsy/models"

export type ModelsOptions = {
  root: string
  providers: string[]
  allowTraining?: boolean
  allowRetention?: boolean
  yes?: boolean
  key?: string
}

export type ModelsResult = {
  lock: ModelLock
  reasons: Record<string, string>
  rejected: Record<string, { openCodeId: string; reason: string }[]>
  failures: Record<string, string>
  written: boolean
  path: string
  changes: { role: string; from?: string; to: string; note: string }[]
}

const PROVIDER_ALIASES: Record<string, ProviderSelection["provider"]> = {
  opencode: "opencode",
  zen: "opencode",
  "opencode-go": "opencode-go",
  go: "opencode-go",
  ollama: "ollama",
  "ollama-local": "ollama",
  "ollama-cloud": "ollama-cloud",
}

export function parseProviders(input: string[]): ProviderSelection[] {
  const seen = new Set<string>()
  const selections: ProviderSelection[] = []
  for (const raw of input) {
    for (const part of raw.split(",")) {
      const name = part.trim().toLowerCase()
      if (name.length === 0) continue
      const provider = PROVIDER_ALIASES[name]
      if (!provider) {
        throw new Error(
          `unknown provider "${name}". Known: ${Object.keys(PROVIDER_ALIASES).join(", ")}`,
        )
      }
      if (seen.has(provider)) continue
      seen.add(provider)
      selections.push({ provider })
    }
  }
  if (selections.length === 0) {
    throw new Error("no providers given. Use --providers opencode-go,ollama-cloud")
  }
  return selections
}

async function confirm(question: string, yes: boolean | undefined): Promise<boolean> {
  if (yes === true) return true
  if (!process.stdin.isTTY) return false
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(`${question} [y/N] `)
    return answer.trim().toLowerCase() === "y"
  } finally {
    rl.close()
  }
}

export async function runModels(options: ModelsOptions): Promise<ModelsResult> {
  const path = join(options.root, LOCK_FILE_NAME)
  const roles = await loadRoles(join(options.root, "roles.yaml"))
  const providers = parseProviders(options.providers)

  const result = await selectModels({
    root: options.root,
    roles,
    providers,
    ...(options.allowTraining !== undefined ? { allowTraining: options.allowTraining } : {}),
    ...(options.allowRetention !== undefined ? { allowRetention: options.allowRetention } : {}),
    ...(options.key !== undefined ? { benchLmKey: options.key } : {}),
  })

  const previous = await readLock(path)
  const changes: ModelsResult["changes"] = []
  for (const [role, entry] of Object.entries(result.lock.roles)) {
    const from = previous?.roles[role]?.model
    changes.push({
      role,
      ...(from !== undefined ? { from } : {}),
      to: entry.model,
      note: result.reasons[role] ?? "",
    })
  }

  const approved =
    Object.keys(result.failures).length === 0
      ? await confirm(
          `Write ${LOCK_FILE_NAME} with these ${changes.length} role assignments?`,
          options.yes,
        )
      : false

  if (approved) {
    await writeLock(path, result.lock)
  }

  return {
    lock: result.lock,
    reasons: result.reasons,
    rejected: result.rejected,
    failures: result.failures,
    written: approved,
    path,
    changes,
  }
}
