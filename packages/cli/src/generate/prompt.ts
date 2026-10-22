import type { RoleDefinition } from "@openagentsy/core"

const BOARD_RECORD = `\`\`\`json
{
  "bean": "proj-42",
  "from": "builder-2",
  "kind": "status | contract | question | blocker | finding",
  "action": "Added GET /search?q= handler",
  "state": "tests: 14/14 pass; owns src/api/search.ts",
  "artifact": "commit a1b2c3 on wt/proj-42",
  "contract": { "GET /search": "-> [{id,title,url}]" },
  "needs": "frontend (proj-43) consume contract",
  "surprise": "Existing index lacks a title column, migration added",
  "confidence": "verified | inferred | guess"
}
\`\`\``

function effortSection(role: RoleDefinition, variants: EffortVariants): string {
  const start = variants.start ?? role.effort.startVariant
  const ceiling = variants.ceiling ?? role.effort.ceilingVariant
  const triggers = role.effort.climbTriggers
  if (triggers.length === 0) {
    return `Start at \`${start}\`. This role does not climb.`
  }
  return [
    `Start at \`${start}\`. Ceiling \`${ceiling}\`.`,
    "",
    "Climb one rung only on a concrete trigger, never on a feeling that the task is hard:",
    ...triggers.map((trigger) => `- \`${trigger}\``),
    "",
    "Say why you climbed, in the board record.",
  ].join("\n")
}

export type EffortVariants = { start?: string; ceiling?: string }

function criticalRules(role: RoleDefinition): string[] {
  const rules = [
    "Stay inside the declared scope. If the task needs work outside it, post a question record instead of doing the work.",
    "Use tools to check facts. Never state a path, an API, or a test result you did not read or run.",
    "Report through a board record, not through prose. A record is the hand-off; prose is not.",
  ]
  if (role.writes) {
    rules.push(
      "Edit only the files leased to you. A file you do not own belongs to another agent.",
    )
  }
  rules.push(
    "If the plan or the instruction looks wrong, say so in a question record. Do not comply silently.",
  )
  return rules
}

/**
 * The agent prompt body. Everything here is derived from the role definition,
 * so a role is described in exactly one place.
 */
export function renderPrompt(role: RoleDefinition, variants: EffortVariants = {}): string {
  const lines: string[] = [
    `# ${role.name}`,
    "",
    `> **Mission**: ${role.description}`,
    "",
    role.scope.trim(),
    "",
    "## Critical rules",
    "",
    ...criticalRules(role).map((rule) => `- ${rule}`),
    "",
    "## Guidance",
    "",
    role.guidance.trim(),
    "",
    "## Reporting",
    "",
    "Post one board record per meaningful state change. Keep it under 150 tokens.",
    "",
    BOARD_RECORD,
    "",
    "Mark every claim `verified`, `inferred` or `guess`. A guess is allowed; a guess",
    "labelled as verified is not.",
    "",
    "Fill `surprise` whenever you learned something the plan did not know. That field",
    "is how the fact only you hold reaches the Lead.",
    "",
    "## Reasoning effort",
    "",
    effortSection(role, variants),
    "",
    "## What not to do",
    "",
    "- Do not spawn other agents unless your permissions say you may.",
    "- Do not push, force-push, or write outside the leased files.",
    "- Do not report a task complete before the acceptance tests pass.",
    "- Do not adopt a persona or a name that suggests more than the role.",
  ]

  return `${lines.join("\n")}\n`
}
