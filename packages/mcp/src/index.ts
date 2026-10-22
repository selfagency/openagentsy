#!/usr/bin/env node
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { appendAudit, POLICIES } from "./audit.js"
import { checkBudget, listBudgets, recordUsage, setBudget } from "./budgets.js"
import { migrate, openDatabase } from "./db.js"
import { checkLease, grantLeases, listLeases } from "./leases.js"
import { BoardError, createRecord, listRecords } from "./records.js"
import { CONFIDENCE_LEVELS, RECORD_KINDS } from "./types.js"

const root = process.env["OPENAGENTSY_ROOT"] ?? process.cwd()
const stateDir = join(root, ".openagentsy")
const databasePath = join(stateDir, "board.sqlite")
const auditPath = join(stateDir, "audit.jsonl")

await mkdir(stateDir, { recursive: true })
const db = openDatabase(databasePath)
migrate(db)

const server = new McpServer(
  { name: "openagentsy", version: "0.1.0" },
  { capabilities: { tools: {} } },
)

function text(value: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] }
}

function failure(error: unknown): { content: { type: "text"; text: string }[]; isError: true } {
  if (error instanceof BoardError) {
    return {
      content: [{ type: "text", text: `${error.message}\n\nNext: ${error.hint}` }],
      isError: true,
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { content: [{ type: "text", text: message }], isError: true }
}

// --- records ----------------------------------------------------------------

server.registerTool(
  "board_post",
  {
    description:
      "Post a typed record to the board. A record is the hand-off between agents: what was done, the state it produced, the artifact, what is needed next, and how confident you are. Keep it under 150 tokens.",
    inputSchema: {
      bean: z.string().describe("Bean this record belongs to"),
      from: z.string().describe("Agent posting the record"),
      kind: z.enum(RECORD_KINDS).describe("status | contract | question | blocker | finding"),
      action: z.string().describe("What was done, one line"),
      state: z.string().describe("The state this produced"),
      confidence: z
        .enum(CONFIDENCE_LEVELS)
        .describe("verified = ran or read it, inferred = reasoned to it, guess = not checked"),
      to: z
        .string()
        .optional()
        .describe("Agent the record is addressed to. Omit to broadcast to the whole board"),
      artifact: z.string().optional().describe("Commit, file or test the result lives in"),
      contract: z.any().optional().describe("Interface other agents will call"),
      needs: z.string().optional().describe("Who has to act next, and what they need"),
      surprise: z
        .string()
        .optional()
        .describe("What you learned that the plan did not know. Fill this whenever something surprised you"),
    },
  },
  async (input) => {
    try {
      const record = createRecord(db, input)
      await appendAudit(auditPath, {
        policyId: POLICIES.recordPost.id,
        policyVersion: POLICIES.recordPost.version,
        actor: input.from,
        action: "board_post",
        resource: `${input.bean}#${record.id}`,
        effect: "allow",
      })
      return text({ id: record.id, createdAt: record.createdAt })
    } catch (error) {
      return failure(error)
    }
  },
)

server.registerTool(
  "board_inbox",
  {
    description:
      "Read the records waiting for one agent and mark them read, in one call. Broadcast records go to every agent. Returns a cursor for the next page, never the whole board.",
    inputSchema: {
      agent: z.string().describe("Agent whose inbox is being read"),
      cursor: z.number().int().optional().describe("Return records after this id"),
      limit: z.number().int().optional().describe("Maximum records to return, default 20"),
      markRead: z.boolean().optional().describe("Mark the returned records read, default true"),
    },
  },
  async (input) => {
    try {
      return text(
        listRecords(db, {
          agent: input.agent,
          ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
          ...(input.markRead !== undefined ? { markRead: input.markRead } : {}),
        }),
      )
    } catch (error) {
      return failure(error)
    }
  },
)

// --- leases -----------------------------------------------------------------

server.registerTool(
  "board_lease_grant",
  {
    description:
      "Record the files one agent owns. Each file has exactly one writer at a time. A glob already leased to another agent is refused.",
    inputSchema: {
      bean: z.string().describe("Bean the lease belongs to"),
      agent: z.string().describe("Agent taking the lease"),
      globs: z.array(z.string()).describe("Path globs, relative to the project root"),
    },
  },
  async (input) => {
    try {
      const result = grantLeases(db, input)
      for (const lease of result.granted) {
        await appendAudit(auditPath, {
          policyId: POLICIES.leaseGrant.id,
          policyVersion: POLICIES.leaseGrant.version,
          actor: input.agent,
          action: "lease_grant",
          resource: lease.glob,
          effect: "allow",
          detail: `bean ${lease.bean}`,
        })
      }
      for (const conflict of result.conflicts) {
        await appendAudit(auditPath, {
          policyId: POLICIES.leaseDeny.id,
          policyVersion: POLICIES.leaseDeny.version,
          actor: input.agent,
          action: "lease_grant",
          resource: conflict.glob,
          effect: "deny",
          detail: `held by ${conflict.agent} on ${conflict.bean}`,
        })
      }
      return text(result)
    } catch (error) {
      return failure(error)
    }
  },
)

server.registerTool(
  "board_lease_check",
  {
    description:
      "Check whether one path may be written. Reports the holder, or a conflict when another agent holds the file.",
    inputSchema: {
      path: z.string().describe("Path being written, absolute or relative to the project root"),
      agent: z.string().optional().describe("Agent asking, so a conflict can be reported"),
    },
  },
  async (input) => {
    try {
      const decision = checkLease(db, {
        path: input.path,
        root,
        ...(input.agent !== undefined ? { agent: input.agent } : {}),
      })
      if (decision.status === "conflict") {
        await appendAudit(auditPath, {
          policyId: POLICIES.leaseDeny.id,
          policyVersion: POLICIES.leaseDeny.version,
          actor: input.agent ?? "unknown",
          action: "lease_check",
          resource: decision.path,
          effect: "deny",
          detail: `held by ${decision.agent ?? "unknown"} on ${decision.bean ?? "unknown"}`,
        })
      }
      return text(decision)
    } catch (error) {
      return failure(error)
    }
  },
)

server.registerTool(
  "board_lease_list",
  {
    description: "List the file leases the board knows about.",
    inputSchema: {
      bean: z.string().optional().describe("Only leases for this bean"),
    },
  },
  async (input) => {
    try {
      return text({ leases: listLeases(db, input.bean) })
    } catch (error) {
      return failure(error)
    }
  },
)

// --- budgets ----------------------------------------------------------------

server.registerTool(
  "board_budget_set",
  {
    description:
      "Set the token budget for a bean. The builder stops at 85 percent of it unless stopAt says otherwise.",
    inputSchema: {
      bean: z.string().describe("Bean the budget belongs to"),
      tokenLimit: z.number().int().positive().describe("Total tokens the bean may spend"),
      stopAt: z.number().int().positive().optional().describe("Token count at which the bean stops"),
    },
  },
  async (input) => {
    try {
      const budget = setBudget(db, {
        bean: input.bean,
        tokenLimit: input.tokenLimit,
        ...(input.stopAt !== undefined ? { stopAt: input.stopAt } : {}),
      })
      await appendAudit(auditPath, {
        policyId: POLICIES.budgetSet.id,
        policyVersion: POLICIES.budgetSet.version,
        actor: "lead",
        action: "budget_set",
        resource: input.bean,
        effect: "allow",
        detail: `limit ${budget.tokenLimit}, stop at ${budget.stopAt}`,
      })
      return text(budget)
    } catch (error) {
      return failure(error)
    }
  },
)

server.registerTool(
  "board_budget_check",
  {
    description:
      "Check a bean against its token budget. Reports whether the bean has to stop and records the usage.",
    inputSchema: {
      bean: z.string().describe("Bean to check"),
      tokensUsed: z.number().int().nonnegative().describe("Tokens spent so far"),
    },
  },
  async (input) => {
    try {
      const decision = checkBudget(db, input.bean, input.tokensUsed)
      if (decision.configured) {
        recordUsage(db, input.bean, input.tokensUsed)
      }
      if (decision.stop) {
        await appendAudit(auditPath, {
          policyId: POLICIES.budgetStop.id,
          policyVersion: POLICIES.budgetStop.version,
          actor: input.bean,
          action: "budget_check",
          resource: input.bean,
          effect: "deny",
          detail: `${input.tokensUsed} tokens used, stop at ${decision.stopAt}`,
        })
      }
      return text(decision)
    } catch (error) {
      return failure(error)
    }
  },
)

server.registerTool(
  "board_budget_list",
  {
    description: "List the token budgets the board knows about.",
    inputSchema: {},
  },
  async () => {
    try {
      return text({ budgets: listBudgets(db) })
    } catch (error) {
      return failure(error)
    }
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
