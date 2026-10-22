import { describe, expect, it } from "vitest"
import { parse as parseYaml } from "yaml"
import { parseRoles, type RolesFile } from "@openagentsy/core"
import { renderAgent } from "./agent.js"
import { renderCommand, COMMANDS } from "./commands.js"

const ROLES = `
version: 1
protectedPaths:
  - "roles.yaml"
defaults:
  permissions:
    read:
      - resource: "*"
        effect: allow
    external_directory:
      - resource: "*"
        effect: ask
roles:
  lead:
    description: Plans and delegates
    mode: primary
    writes: false
    scope: the plan
    guidance: classify first
    permissions:
      shell:
        - resource: "*"
          effect: ask
        - resource: "git status*"
          effect: allow
      subagent:
        - resource: "*"
          effect: deny
        - resource: "oa-scout"
          effect: allow
    skills: []
    modelProfile:
      primarySignal: agentic
      hardRequirements: [tool_calls]
      costStance: quality_first
    effort:
      startVariant: medium
      ceilingVariant: xhigh
      climbTriggers: [planning]
  builder:
    description: Implements a bean
    mode: subagent
    hidden: true
    writes: true
    steps: 40
    scope: only leased files
    guidance: test the change
    permissions:
      edit:
        - resource: "*"
          effect: allow
      shell:
        - resource: "*"
          effect: ask
        - resource: "git push*"
          effect: deny
    skills: [openagentsy-handoff]
    modelProfile:
      primarySignal: coding
      hardRequirements: [tool_calls]
      costStance: balanced
    effort:
      startVariant: medium
      ceilingVariant: high
      climbTriggers: [test_failed_twice]
`

function roles(): RolesFile {
  return parseRoles(ROLES)
}

function frontmatter(markdown: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown)
  if (!match) throw new Error("no frontmatter found")
  return parseYaml(match[1]!) as Record<string, unknown>
}

describe("renderAgent for V1", () => {
  it("writes a permission map", () => {
    const file = roles()
    const markdown = renderAgent(file.roles["builder"]!, file, { target: "v1" })
    const meta = frontmatter(markdown)
    expect(meta["permission"]).toBeDefined()
    expect(meta["permissions"]).toBeUndefined()
  })

  it("names the spawn tool task", () => {
    const file = roles()
    const meta = frontmatter(renderAgent(file.roles["lead"]!, file, { target: "v1" }))
    const permission = meta["permission"] as Record<string, unknown>
    expect(permission["task"]).toEqual({ "*": "deny", "oa-scout": "allow" })
  })

  it("asks for the protected paths of a write-capable role", () => {
    const file = roles()
    const meta = frontmatter(renderAgent(file.roles["builder"]!, file, { target: "v1" }))
    const permission = meta["permission"] as Record<string, Record<string, string>>
    expect(permission["edit"]).toEqual({ "*": "allow", "roles.yaml": "ask" })
  })

  it("omits the model when there is no lock file", () => {
    const file = roles()
    const meta = frontmatter(renderAgent(file.roles["builder"]!, file, { target: "v1" }))
    expect(meta["model"]).toBeUndefined()
  })

  it("writes the model when the lock file provides one", () => {
    const file = roles()
    const meta = frontmatter(
      renderAgent(file.roles["builder"]!, file, { target: "v1", model: "opencode/kimi-k3" }),
    )
    expect(meta["model"]).toBe("opencode/kimi-k3")
  })
})

describe("renderAgent for V2", () => {
  it("writes an ordered permission list", () => {
    const file = roles()
    const meta = frontmatter(renderAgent(file.roles["builder"]!, file, { target: "v2" }))
    expect(meta["permissions"]).toBeInstanceOf(Array)
    expect(meta["permission"]).toBeUndefined()
  })

  it("names the spawn tool subagent", () => {
    const file = roles()
    const meta = frontmatter(renderAgent(file.roles["lead"]!, file, { target: "v2" }))
    const permissions = meta["permissions"] as { action: string; resource: string; effect: string }[]
    expect(permissions).toContainEqual({ action: "subagent", resource: "*", effect: "deny" })
    expect(permissions).toContainEqual({ action: "subagent", resource: "oa-scout", effect: "allow" })
  })

  it("pins the starting variant in the model", () => {
    const file = roles()
    const meta = frontmatter(
      renderAgent(file.roles["builder"]!, file, {
        target: "v2",
        model: "opencode/kimi-k3",
        modelVariant: "medium",
      }),
    )
    expect(meta["model"]).toBe("opencode/kimi-k3#medium")
  })

  it("leaves out the list and lsp actions V2 does not have", () => {
    const file = roles()
    const meta = frontmatter(renderAgent(file.roles["builder"]!, file, { target: "v2" }))
    const permissions = meta["permissions"] as { action: string }[]
    const actions = new Set(permissions.map((rule) => rule.action))
    expect(actions.has("list")).toBe(false)
    expect(actions.has("lsp")).toBe(false)
  })
})

describe("the agent body", () => {
  it("carries the scope, the guidance and the reporting format", () => {
    const file = roles()
    const markdown = renderAgent(file.roles["builder"]!, file, { target: "v1" })
    expect(markdown).toContain("only leased files")
    expect(markdown).toContain("test the change")
    expect(markdown).toContain("confidence")
  })

  it("names the climb triggers of the role", () => {
    const file = roles()
    const markdown = renderAgent(file.roles["builder"]!, file, { target: "v1" })
    expect(markdown).toContain("test_failed_twice")
  })
})

describe("renderCommand", () => {
  it("uses subtask for V1 and subagent for V2", () => {
    const command = COMMANDS.find((entry) => entry.name === "review")!
    const v1 = frontmatter(renderCommand(command, "v1"))
    const v2 = frontmatter(renderCommand(command, "v2"))
    expect(v1["subtask"]).toBe(true)
    expect(v1["subagent"]).toBeUndefined()
    expect(v2["subagent"]).toBe(true)
    expect(v2["subtask"]).toBeUndefined()
  })

  it("points each command at its agent", () => {
    const command = COMMANDS.find((entry) => entry.name === "review")!
    expect(frontmatter(renderCommand(command, "v1"))["agent"]).toBe("oa-reviewer")
  })
})
