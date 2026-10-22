import { describe, expect, it } from "vitest"
import { parseAliases, parsePolicy, quotaFor, retentionFor, PolicyError } from "./policy.js"

const POLICY = `
version: 1
defaults:
  trainsOnPrompts: false
  zeroDataRetention: true
  retentionDays: 0
providers:
  opencode-go:
    source: https://opencode.ai/v2/docs/console/go/
    checkedAt: "2026-10-22"
    models:
      kimi-k3:
        monthlyCapUsd: 15
        requestsPer5h: 110
      gemini-4-argon-contributor:
        trainsOnPrompts: true
        zeroDataRetention: false
        retentionDays: 30
  ollama-cloud:
    source: https://ollama.com/search?c=cloud
    checkedAt: "2026-10-22"
`

describe("parsePolicy", () => {
  it("reads the defaults and the providers", () => {
    const policy = parsePolicy(POLICY)
    expect(policy.version).toBe(1)
    expect(policy.defaults.zeroDataRetention).toBe(true)
    expect(Object.keys(policy.providers)).toEqual(["opencode-go", "ollama-cloud"])
  })

  it("gives a provider without a model list an empty list", () => {
    const policy = parsePolicy(POLICY)
    expect(policy.providers["ollama-cloud"]!.models).toEqual({})
  })

  it("rejects a file with the wrong version", () => {
    expect(() => parsePolicy(POLICY.replace("version: 1", "version: 9"))).toThrow(PolicyError)
  })
})

describe("retentionFor", () => {
  const policy = parsePolicy(POLICY)

  it("uses the provider defaults for a model that is not listed", () => {
    const retention = retentionFor(policy, "opencode-go", "glm-5.3")
    expect(retention.trainsOnPrompts).toBe(false)
    expect(retention.zeroDataRetention).toBe(true)
    expect(retention.source).toContain("console/go")
  })

  it("uses the documented terms for a listed model", () => {
    const retention = retentionFor(policy, "opencode-go", "gemini-4-argon-contributor")
    expect(retention.trainsOnPrompts).toBe(true)
    expect(retention.zeroDataRetention).toBe(false)
    expect(retention.retentionDays).toBe(30)
  })

  it("reads the strictest case for a provider it does not know", () => {
    const retention = retentionFor(policy, "ollama", "anything")
    expect(retention.trainsOnPrompts).toBe(true)
    expect(retention.zeroDataRetention).toBe(false)
  })
})

describe("quotaFor", () => {
  const policy = parsePolicy(POLICY)

  it("reads the caps of a listed model", () => {
    const quota = quotaFor(policy, "opencode-go", "kimi-k3")
    expect(quota?.requestsPer5h).toBe(110)
    expect(quota?.monthlyCapUsd).toBe(15)
  })

  it("returns nothing for a model with no caps", () => {
    expect(quotaFor(policy, "opencode-go", "glm-5.3")).toBeUndefined()
  })
})

describe("parseAliases", () => {
  it("reads the alias table", () => {
    const file = parseAliases('version: 1\naliases:\n  "opencode-go/kimi-k3": kimi-k3\n')
    expect(file.aliases["opencode-go/kimi-k3"]).toBe("kimi-k3")
  })

  it("rejects a file with the wrong version", () => {
    expect(() => parseAliases('version: 2\naliases: {}\n')).toThrow(PolicyError)
  })
})
