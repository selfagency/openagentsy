import { readFile } from "node:fs/promises"
import { parse as parseYaml } from "yaml"
import type { ProviderId, Quota, Retention } from "./types.js"

export type PolicyModel = {
  trainsOnPrompts?: boolean
  zeroDataRetention?: boolean
  retentionDays?: number
  monthlyCapUsd?: number
  monthlyCapUsdPlus?: number
  requestsPer5h?: number
  requestsPer5hPlus?: number
  note?: string
}

export type PolicyProvider = {
  source: string
  checkedAt: string
  note?: string
  models: Record<string, PolicyModel>
}

export type PolicyFile = {
  version: number
  defaults: {
    trainsOnPrompts: boolean
    zeroDataRetention: boolean
    retentionDays: number
  }
  providers: Record<string, PolicyProvider>
}

export class PolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PolicyError"
  }
}

export function parsePolicy(text: string): PolicyFile {
  const raw = parseYaml(text) as Partial<PolicyFile> | null
  if (!raw || typeof raw !== "object") {
    throw new PolicyError("policy file: expected a mapping")
  }
  if (raw.version !== 1) {
    throw new PolicyError(`policy file: expected version 1, got ${String(raw.version)}`)
  }
  if (!raw.defaults || !raw.providers) {
    throw new PolicyError("policy file: defaults and providers are required")
  }
  const providers: Record<string, PolicyProvider> = {}
  for (const [id, provider] of Object.entries(raw.providers)) {
    providers[id] = { ...provider, models: provider.models ?? {} }
  }
  return { ...raw, providers } as PolicyFile
}

export async function loadPolicy(path: string): Promise<PolicyFile> {
  return parsePolicy(await readFile(path, "utf8"))
}

export type AliasFile = {
  version: number
  aliases: Record<string, string>
}

export function parseAliases(text: string): AliasFile {
  const raw = parseYaml(text) as Partial<AliasFile> | null
  if (!raw || typeof raw !== "object" || raw.version !== 1 || !raw.aliases) {
    throw new PolicyError("alias file: expected version 1 and an aliases mapping")
  }
  return raw as AliasFile
}

export async function loadAliases(path: string): Promise<AliasFile> {
  return parseAliases(await readFile(path, "utf8"))
}

/**
 * The retention terms of one model.
 *
 * A model that is not named in the policy file inherits the provider
 * defaults. A provider that is not in the file at all gets the strictest
 * reading, so an unknown provider is never treated as safe by accident.
 */
export function retentionFor(policy: PolicyFile, provider: ProviderId, modelId: string): Retention {
  const providerPolicy = policy.providers[provider]
  const model = providerPolicy?.models?.[modelId]
  const defaults = policy.defaults

  if (!providerPolicy) {
    return {
      trainsOnPrompts: true,
      zeroDataRetention: false,
      retentionDays: 30,
      source: "unknown provider, read as the strictest case",
      checkedAt: "unknown",
    }
  }

  return {
    trainsOnPrompts: model?.trainsOnPrompts ?? defaults.trainsOnPrompts,
    zeroDataRetention: model?.zeroDataRetention ?? defaults.zeroDataRetention,
    retentionDays: model?.retentionDays ?? defaults.retentionDays,
    source: providerPolicy.source,
    checkedAt: providerPolicy.checkedAt,
  }
}

export function quotaFor(policy: PolicyFile, provider: ProviderId, modelId: string): Quota | undefined {
  const providerPolicy = policy.providers[provider]
  if (!providerPolicy) return undefined
  const model = providerPolicy.models?.[modelId]
  if (!model) return undefined

  const quota: Quota = { source: providerPolicy.source }
  if (model.monthlyCapUsd !== undefined) quota.monthlyCapUsd = model.monthlyCapUsd
  if (model.monthlyCapUsdPlus !== undefined) quota.monthlyCapUsdPlus = model.monthlyCapUsdPlus
  if (model.requestsPer5h !== undefined) quota.requestsPer5h = model.requestsPer5h
  if (model.requestsPer5hPlus !== undefined) quota.requestsPer5hPlus = model.requestsPer5hPlus
  return quota
}
