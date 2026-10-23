#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  appendAudit,
  BoardError,
  CONFIDENCE_LEVELS,
  checkBudget,
  checkLease,
  createRecord,
  grantLeases,
  listBudgets,
  listLeases,
  listRecords,
  migrate,
  openDatabase,
  POLICIES,
  RECORD_KINDS,
  recordUsage,
  releaseLease,
  setBudget,
} from '@openagentsy/core';
import { z } from 'zod';

const root = process.env.OPENAGENTSY_ROOT ?? process.cwd();
const stateDir = join(root, '.openagentsy');

/**
 * The writer cap.
 *
 * The plan allows three writers at once. The board refuses a lease that would
 * put a fourth writer on it, so the cap is a rule and not a note in a prompt.
 */
const WRITER_CAP = 3;
const databasePath = join(stateDir, 'board.sqlite');
const auditPath = join(stateDir, 'audit.jsonl');

await mkdir(stateDir, { recursive: true });
const rawDb = openDatabase(databasePath);
migrate(rawDb);

/**
 * The fault switch.
 *
 * `OPENAGENTSY_FAULT` makes the board fail on purpose, so a case can check
 * what an agent does when the board is not there. The database is the one
 * thing every tool goes through, so the fault is injected there and every
 * tool fails the same way.
 */
const fault = process.env.OPENAGENTSY_FAULT ?? '';
const db =
  fault === ''
    ? rawDb
    : new Proxy(rawDb, {
        get(target, property, receiver) {
          // Drizzle's query builders all start at one of these methods, so
          // failing them fails every tool the same way.
          if (
            property === 'select' ||
            property === 'insert' ||
            property === 'update' ||
            property === 'delete' ||
            property === 'run'
          ) {
            return () => {
              throw new BoardError(
                `The board did not answer. Injected fault: ${fault}.`,
                'Do not retry in a loop. Say the board is unreachable and stop.',
              );
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });

/**
 * The usage card.
 *
 * The MCP protocol hands the server a place to describe itself, and the
 * client puts it in the system prompt. So the card is the board's whole
 * documentation to an agent, and it is paid for on every turn. It is
 * therefore short, and it says only what an agent cannot infer: which tool
 * does what, and the three rules that hold everywhere.
 */
const USAGE_CARD = `The OpenAgentsy board. The tools:
- board_record: the records, the hand-off between agents. op=post leaves a typed record (kind is status, contract, question, blocker or finding; every record carries a confidence: verified, inferred or guess). op=inbox reads the records addressed to you and marks them read, a cursor at a time.
- board_lease: the leases, which agent may write which file. op=check asks whether you may write a path. op=release gives a lease back, and only the holder may release it. op=list lists the leases.
- board_lease_grant: take a lease on files. The Lead only; every other role has this tool denied by name.
- board_budget: the token budgets. op=check reports whether a bean is over its budget; at 85 percent the builder stops and posts a blocker. op=list lists the budgets.
- board_budget_set: set a token budget for a bean. The Lead only.
Three rules hold everywhere: one writer per file, a write without a lease is refused, and every decision is on the record. An error names the next call to make.`;

/**
 * A field the chosen op needs.
 *
 * The grouped tools take one flat schema, so the field that belongs to the
 * op is checked here rather than by the schema.
 */
function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new BoardError(
      `The call is missing ${name}.`,
      'The description of the tool says which field belongs to which op.',
    );
  }
  return value;
}

const server = new McpServer(
  { name: 'openagentsy', version: '0.1.0' },
  { capabilities: { tools: {} }, instructions: USAGE_CARD },
);

function text(value: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function failure(error: unknown): { content: { type: 'text'; text: string }[]; isError: true } {
  if (error instanceof BoardError) {
    return {
      content: [{ type: 'text', text: `${error.message}\n\nNext: ${error.hint}` }],
      isError: true,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text', text: message }], isError: true };
}

// --- records ----------------------------------------------------------------

server.registerTool(
  'board_record',
  {
    description:
      'The records on the board: the hand-off between agents. op=post leaves a typed record for another agent (kind is status, contract, question, blocker or finding; every record carries a confidence: verified, inferred or guess). op=inbox reads the records addressed to you and marks them read, a cursor at a time.',
    inputSchema: {
      op: z.enum(['post', 'inbox']).describe('What this call does'),
      bean: z.string().optional().describe('post: the bean this record belongs to'),
      from: z.string().optional().describe('post: the agent posting the record'),
      kind: z
        .enum(RECORD_KINDS)
        .optional()
        .describe('post: status | contract | question | blocker | finding'),
      action: z.string().optional().describe('post: what was done, one line'),
      state: z.string().optional().describe('post: the state this produced'),
      confidence: z
        .enum(CONFIDENCE_LEVELS)
        .optional()
        .describe(
          'post: verified = ran or read it, inferred = reasoned to it, guess = not checked',
        ),
      to: z
        .string()
        .optional()
        .describe(
          'post: the agent the record is addressed to. Omit to broadcast to the whole board',
        ),
      artifact: z
        .string()
        .optional()
        .describe('post: the commit, file or test the result lives in'),
      contract: z.any().optional().describe('post: the interface other agents will call'),
      needs: z.string().optional().describe('post: who has to act next, and what they need'),
      surprise: z.string().optional().describe('post: what you learned that the plan did not know'),
      agent: z.string().optional().describe('inbox: whose inbox is read'),
      cursor: z.number().int().optional().describe('inbox: return records after this id'),
      limit: z.number().int().optional().describe('inbox: maximum records to return, default 20'),
      markRead: z
        .boolean()
        .optional()
        .describe('inbox: mark the returned records read, default true'),
    },
  },
  async (input) => {
    try {
      return input.op === 'post'
        ? await postRecord(input)
        : text(
            listRecords(db, {
              agent: required(input.agent, 'agent'),
              ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
              ...(input.limit !== undefined ? { limit: input.limit } : {}),
              ...(input.markRead !== undefined ? { markRead: input.markRead } : {}),
            }),
          );
    } catch (error) {
      return failure(error);
    }
  },
);

/**
 * Post a record.
 *
 * The record is the hand-off between agents, so it carries what was done,
 * the state it produced, and how confident the poster is.
 */
async function postRecord(input: {
  bean?: string | undefined;
  from?: string | undefined;
  kind?: (typeof RECORD_KINDS)[number] | undefined;
  action?: string | undefined;
  state?: string | undefined;
  confidence?: (typeof CONFIDENCE_LEVELS)[number] | undefined;
  to?: string | undefined;
  artifact?: string | undefined;
  contract?: unknown;
  needs?: string | undefined;
  surprise?: string | undefined;
}): Promise<{ content: { type: 'text'; text: string }[] }> {
  const record = createRecord(db, {
    bean: required(input.bean, 'bean'),
    from: required(input.from, 'from'),
    kind: required(input.kind, 'kind'),
    action: required(input.action, 'action'),
    state: required(input.state, 'state'),
    confidence: required(input.confidence, 'confidence'),
    to: input.to,
    artifact: input.artifact,
    contract: input.contract,
    needs: input.needs,
    surprise: input.surprise,
  });
  await appendAudit(auditPath, {
    policyId: POLICIES.recordPost.id,
    policyVersion: POLICIES.recordPost.version,
    actor: input.from ?? 'unknown',
    action: 'board_record',
    resource: `${input.bean ?? 'unknown'}#${record.id}`,
    effect: 'allow',
  });
  return text({ id: record.id, createdAt: record.createdAt });
}

// --- leases -----------------------------------------------------------------

server.registerTool(
  'board_lease_grant',
  {
    description:
      'Record the files one agent owns. Each file has exactly one writer at a time. A glob already leased to another agent is refused. The Lead only; every other role has this tool denied by name.',
    inputSchema: {
      bean: z.string().describe('Bean the lease belongs to'),
      agent: z.string().describe('Agent taking the lease'),
      globs: z.array(z.string()).describe('Path globs, relative to the project root'),
    },
  },
  async (input) => {
    try {
      const result = grantLeases(db, input, { writerCap: WRITER_CAP });
      for (const lease of result.granted) {
        await appendAudit(auditPath, {
          policyId: POLICIES.leaseGrant.id,
          policyVersion: POLICIES.leaseGrant.version,
          actor: input.agent,
          action: 'lease_grant',
          resource: lease.glob,
          effect: 'allow',
          detail: `bean ${lease.bean}`,
        });
      }
      for (const conflict of result.conflicts) {
        await appendAudit(auditPath, {
          policyId: POLICIES.leaseDeny.id,
          policyVersion: POLICIES.leaseDeny.version,
          actor: input.agent,
          action: 'lease_grant',
          resource: conflict.glob,
          effect: 'deny',
          detail: `held by ${conflict.agent} on ${conflict.bean}`,
        });
      }
      if (result.capReached) {
        await appendAudit(auditPath, {
          policyId: POLICIES.leaseDeny.id,
          policyVersion: POLICIES.leaseDeny.version,
          actor: input.agent,
          action: 'lease_grant',
          resource: input.globs.join(', '),
          effect: 'deny',
          detail: `the writer cap is ${result.capReached.cap} and ${result.capReached.writers} writers already hold a lease`,
        });
      }
      return text(result);
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  'board_lease',
  {
    description:
      'The leases on the board: which agent may write which file. op=check asks whether one path may be written and reports the holder, or a conflict when another agent holds the file. op=release gives a lease back, and only the holder may release it. op=list lists the leases.',
    inputSchema: {
      op: z.enum(['check', 'release', 'list']).describe('What this call does'),
      path: z
        .string()
        .optional()
        .describe('check: the path being written, absolute or relative to the project root'),
      agent: z
        .string()
        .optional()
        .describe(
          'check: the agent asking, so a conflict can be reported; release: the agent holding the lease',
        ),
      bean: z
        .string()
        .optional()
        .describe('release: the bean the lease belongs to; list: only leases for this bean'),
      globs: z
        .array(z.string())
        .optional()
        .describe('release: the path globs to give back, relative to the project root'),
    },
  },
  async (input) => {
    try {
      if (input.op === 'check') return await checkOneLease(input);
      if (input.op === 'release') return await releaseLeases(input);
      return text({ leases: listLeases(db, input.bean) });
    } catch (error) {
      return failure(error);
    }
  },
);

/**
 * Ask whether one path may be written.
 *
 * A conflict is on the record, because a refused write is a decision.
 */
async function checkOneLease(input: {
  path?: string | undefined;
  agent?: string | undefined;
}): Promise<{ content: { type: 'text'; text: string }[] }> {
  const decision = checkLease(db, {
    path: required(input.path, 'path'),
    root,
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
  });
  if (decision.status === 'conflict') {
    await appendAudit(auditPath, {
      policyId: POLICIES.leaseDeny.id,
      policyVersion: POLICIES.leaseDeny.version,
      actor: input.agent ?? 'unknown',
      action: 'lease_check',
      resource: decision.path,
      effect: 'deny',
      detail: `held by ${decision.agent ?? 'unknown'} on ${decision.bean ?? 'unknown'}`,
    });
  }
  return text(decision);
}

/**
 * Give leases back.
 *
 * Only the holder may release a lease, and a glob that was not held is
 * named so the caller knows what is still locked.
 */
async function releaseLeases(input: {
  bean?: string | undefined;
  agent?: string | undefined;
  globs?: string[] | undefined;
}): Promise<{ content: { type: 'text'; text: string }[] }> {
  const bean = required(input.bean, 'bean');
  const agent = required(input.agent, 'agent');
  const released = [];
  const notHeld = [];
  for (const glob of required(input.globs, 'globs')) {
    const result = releaseLease(db, { bean, agent, glob });
    if (result.released && result.lease) {
      released.push(result.lease);
      await appendAudit(auditPath, {
        policyId: POLICIES.leaseRelease.id,
        policyVersion: POLICIES.leaseRelease.version,
        actor: agent,
        action: 'lease_release',
        resource: result.lease.glob,
        effect: 'allow',
        detail: `bean ${bean}`,
      });
    } else {
      notHeld.push(glob);
    }
  }
  return text({ released, notHeld });
}

// --- budgets ----------------------------------------------------------------

server.registerTool(
  'board_budget_set',
  {
    description:
      'Set the token budget for a bean. The builder stops at 85 percent of it unless stopAt says otherwise. The Lead only.',
    inputSchema: {
      bean: z.string().describe('Bean the budget belongs to'),
      tokenLimit: z.number().int().positive().describe('Total tokens the bean may spend'),
      stopAt: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Token count at which the bean stops'),
    },
  },
  async (input) => {
    try {
      const budget = setBudget(db, {
        bean: input.bean,
        tokenLimit: input.tokenLimit,
        ...(input.stopAt !== undefined ? { stopAt: input.stopAt } : {}),
      });
      await appendAudit(auditPath, {
        policyId: POLICIES.budgetSet.id,
        policyVersion: POLICIES.budgetSet.version,
        actor: 'lead',
        action: 'budget_set',
        resource: input.bean,
        effect: 'allow',
        detail: `limit ${budget.tokenLimit}, stop at ${budget.stopAt}`,
      });
      return text(budget);
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  'board_budget',
  {
    description:
      'The token budgets on the board. op=check reports whether a bean is over its budget and records the usage; at 85 percent the builder stops and posts a blocker. op=list lists the budgets.',
    inputSchema: {
      op: z.enum(['check', 'list']).describe('What this call does'),
      bean: z.string().optional().describe('check: the bean to check'),
      tokensUsed: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('check: the tokens spent so far'),
    },
  },
  async (input) => {
    try {
      if (input.op === 'check') {
        const bean = required(input.bean, 'bean');
        const tokensUsed = required(input.tokensUsed, 'tokensUsed');
        const decision = checkBudget(db, bean, tokensUsed);
        if (decision.configured) {
          recordUsage(db, bean, tokensUsed);
        }
        if (decision.stop) {
          await appendAudit(auditPath, {
            policyId: POLICIES.budgetStop.id,
            policyVersion: POLICIES.budgetStop.version,
            actor: bean,
            action: 'budget_check',
            resource: bean,
            effect: 'deny',
            detail: `${tokensUsed} tokens used, stop at ${decision.stopAt}`,
          });
        }
        return text(decision);
      }

      return text({ budgets: listBudgets(db) });
    } catch (error) {
      return failure(error);
    }
  },
);
const transport = new StdioServerTransport();
await server.connect(transport);
