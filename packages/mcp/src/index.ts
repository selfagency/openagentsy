#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  appendAudit,
  BoardError,
  type BudgetDecision,
  type boardToolNames,
  CONFIDENCE_LEVELS,
  checkBudget,
  checkLease,
  createRecord,
  type Dispatch,
  dispatchProfileCriteria,
  grantLeases,
  type Lease,
  listBudgets,
  listLeases,
  listRecords,
  loadRoles,
  migrate,
  openDatabase,
  POLICIES,
  RECORD_KINDS,
  recordUsage,
  releaseLease,
  resolveStateRoot,
  revokeLease,
  rotateAudit,
  setBudget,
  validateDispatch,
} from '@openagentsy/core';
import { choice, createJevClient, isJevAvailable } from '@openagentsy/jev';
import { z } from 'zod';
import { ledgerReaders } from './ledger-usage.js';
import { createLessonTools } from './lessons.js';
import { failure, type McpToolResult, text } from './mcp-tool.js';
import { createWaiverTools, WAIVER_TOOL_NAME } from './waivers.js';
import { workspaceTools } from './workspace-tools.js';

/**
 * The two roots of the server (§3.9).
 *
 * The workspace is the session's own directory: the worktree, when the
 * server runs in one. It holds the project files the session reads and the
 * task files of .beans/, which travel with the branch.
 *
 * The state root is the directory that owns the shared OpenAgentsy state:
 * the board database, the leases, the records, the audit log, the ledger,
 * the lessons and the waivers. In a linked worktree it is the MAIN
 * repository root, so a builder in a worktree posts to the board the Lead
 * reads instead of to a board of its own.
 */
const workspace = process.env.OPENAGENTSY_ROOT ?? process.cwd();
const stateRoot = resolveStateRoot(workspace);
const stateDir = join(stateRoot, '.openagentsy');

/**
 * The writer cap.
 *
 * The plan allows three writers at once. The board refuses a lease that would
 * put a fourth writer on it, so the cap is a rule and not a note in a prompt.
 */
const WRITER_CAP = 3;
const databasePath = join(stateDir, 'board.sqlite');
const auditPath = join(stateDir, 'audit.jsonl');

/**
 * The usage the ledger measured.
 *
 * The cap stays in the board and the usage comes from the ledger (§6.7), so
 * the check asks the ledger what a bean spent. A project without a ledger
 * falls back to the self-report the board already holds.
 */
const usageReaders = ledgerReaders(stateRoot);

const AGENTS = await knownAgents();
/**
 * The agents the board knows.
 *
 * A record carries the name of the agent that posted it, and the board
 * cannot verify who is calling it, so the name is checked against the roles
 * file: a role key, the agent id the role carries, and the 'oa-' form of
 * the key all name the same agent. A name outside that vocabulary is a
 * record nobody can attribute.
 *
 * A project without a roles file has no vocabulary, and the check does not
 * run: a board that cannot know the names does not refuse them.
 */
async function knownAgents(): Promise<Set<string> | undefined> {
  try {
    const roles = await loadRoles(join(workspace, 'roles.yaml'));
    const names = new Set<string>();
    for (const [key, role] of Object.entries(roles.roles)) {
      names.add(key.toLowerCase());
      names.add(`oa-${key}`.toLowerCase());
      if (role.agentName) names.add(role.agentName.toLowerCase());
    }
    return names;
  } catch {
    return undefined;
  }
}

/**
 * Whether a name names an agent the board knows.
 *
 * The roles file names the roles; an agent may post under the role key,
 * under the agent id the role carries, under the 'oa-' form, or under one of
 * those with an instance number ('builder-2' is the second builder). A name
 * outside that vocabulary is a record nobody can attribute.
 */
function isKnownAgent(name: string): boolean {
  if (AGENTS === undefined) return true;
  const lower = name.trim().toLowerCase();
  if (AGENTS.has(lower)) return true;
  const role = lower.replace(/-\d+$/, '');
  if (AGENTS.has(role)) return true;
  return AGENTS.has(`oa-${role}`);
}

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
- board_lease_revoke: take a lease back from an agent that is not using it, for example a session that died holding it. The Lead only.
- board_budget: the token budgets. op=check reports whether a bean is over its budget, measured from the ledger; at 85 percent the builder stops and posts a blocker. op=list lists the budgets, each carrying 'measured' = the usage the ledger counted for the bean and 'tokensUsed' = the deprecated self-report the check ignores. The self-reported usage is deprecated: the ledger measures the usage and the check reads it there, so a self-report is ignored by the check.
- board_budget_set: set a token budget for a bean. The Lead only.
- board_classify: classify a request into the dispatch profiles, with the probability of each. The Lead calls it before it spawns anything.
- oa_task_*: the todo list of the project. list, show, create, update, next, archive.
- oa_memory_*: the memories a person decided to keep. search, list. The decide tool is a person's, not an agent's.
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

/**
 * The failure of a board call, as the board answers it.
 *
 * A board error carries the next step, and the next step is what the
 * caller needs, so it goes with the reason.
 */
function failureOf(error: unknown): McpToolResult {
  if (error instanceof BoardError) return failure(error.message, error.hint);
  return failure(error instanceof Error ? error.message : String(error));
}

// --- records ----------------------------------------------------------------

/**
 * The board tool names, in one place.
 *
 * The list lives in core, so the vocabulary that resolves a tool name back
 * to its base name and the tools this server offers cannot drift apart.
 * The type says a name has to be one core knows, and that every name core
 * knows has to be here: a rename in core, or a name added to core, stops
 * the build here instead of serving a tool nobody can name.
 */
const BOARD_TOOL = {
  board_record: 'board_record',
  board_lease_grant: 'board_lease_grant',
  board_lease: 'board_lease',
  board_budget_set: 'board_budget_set',
  board_budget: 'board_budget',
  board_lease_revoke: 'board_lease_revoke',
  board_classify: 'board_classify',
} as const satisfies { [K in (typeof boardToolNames)[number]]: K };

server.registerTool(
  BOARD_TOOL.board_record,
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
      contract: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('post: the interface other agents will call'),
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
      return failureOf(error);
    }
  },
);

/**
 * Whether a contract payload is a delegation.
 *
 * A delegation names the agent that does the work and what has to come back.
 * The payload is one when it carries EITHER half - a dispatch that is missing
 * its owner still has a return condition, and one that is missing its return
 * condition still has an owner, and the board has to be able to refuse both.
 * An interface - the shape another agent will call - carries neither, so the
 * board does not ask an interface for an owner.
 */
function isDelegation(contract: unknown): contract is Dispatch {
  return (
    typeof contract === 'object' &&
    contract !== null &&
    !Array.isArray(contract) &&
    ('owner' in contract || 'returnCondition' in contract)
  );
}

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
  const from = required(input.from, 'from');
  if (!isKnownAgent(from)) {
    await appendAudit(auditPath, {
      policyId: POLICIES.recordIdentity.id,
      policyVersion: POLICIES.recordIdentity.version,
      actor: from,
      action: 'board_record',
      resource: input.bean ?? 'unknown',
      effect: 'deny',
      detail: 'the name is not one of the agents in the roles file',
    });
    throw new BoardError(
      `The board does not know an agent called ${from}.`,
      'Use the role key, the agent id, or the oa- form of the key.',
    );
  }

  // A delegated item has an owner and a return condition (plan 8.7). A
  // contract record that names an owner IS a delegation, so the board refuses
  // it when either half is missing; a contract that names neither is an
  // interface, and an interface needs no owner.
  if (input.kind === 'contract' && isDelegation(input.contract)) {
    validateDispatch(input.contract as Dispatch);
  }

  const record = createRecord(db, {
    bean: required(input.bean, 'bean'),
    from,
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

// --- lessons ----------------------------------------------------------------

// The lesson tools: an agent may PROPOSE a lesson, and only a person may
// DECIDE one. The permission map keeps every agent role away from the
// decision tool (roles.yaml), and the hook rule is the second layer.
const LESSON_TOOLS = createLessonTools(stateRoot);

server.registerTool(
  'oa_lesson_propose',
  {
    description: LESSON_TOOLS.oa_lesson_propose.description,
    inputSchema: LESSON_TOOLS.oa_lesson_propose.inputSchema,
  },
  async (input) => LESSON_TOOLS.oa_lesson_propose.handler(input),
);

server.registerTool(
  'oa_lesson_decide',
  {
    description: LESSON_TOOLS.oa_lesson_decide.description,
    inputSchema: LESSON_TOOLS.oa_lesson_decide.inputSchema,
  },
  async (input) => LESSON_TOOLS.oa_lesson_decide.handler(input),
);

// --- waivers ----------------------------------------------------------------

// A quality waiver is a decision a person makes. The permission map takes
// the tool away from every agent role (roles.yaml), and the hook rule is
// the second layer: the hook cannot see an MCP call on the pinned binary,
// so the map is the enforcement and the rule is the backstop.
const WAIVER_TOOLS = createWaiverTools(stateRoot);

server.registerTool(
  WAIVER_TOOL_NAME,
  {
    description: WAIVER_TOOLS.oa_quality_waive.description,
    inputSchema: WAIVER_TOOLS.oa_quality_waive.inputSchema,
  },
  async (input) => WAIVER_TOOLS.oa_quality_waive.handler(input),
);

// --- the workspace tools ---------------------------------------------------

// The task tools and the memory tools: the packages that hold the state
// offer tools of their own, and the board server is where a session finds
// them. The names, the descriptions and the schemas come from the
// packages; the server opens the stores they read and writes.
const WORKSPACE_TOOLS = await workspaceTools({ workspace, stateRoot, db });

for (const tool of WORKSPACE_TOOLS) {
  server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: tool.inputSchema },
    async (input) => tool.handler(input),
  );
}

// --- leases -----------------------------------------------------------------

server.registerTool(
  BOARD_TOOL.board_lease_grant,
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
      for (const held of result.alreadyHeld) {
        // The agent already holds this one, so nothing was granted and
        // nothing was refused. The result says which, so the caller does
        // not read the empty list as a failure.
        await appendAudit(auditPath, {
          policyId: POLICIES.leaseGrant.id,
          policyVersion: POLICIES.leaseGrant.version,
          actor: input.agent,
          action: 'lease_grant',
          resource: held.glob,
          effect: 'allow',
          detail: `already held on bean ${held.bean}`,
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
      return failureOf(error);
    }
  },
);

server.registerTool(
  BOARD_TOOL.board_lease,
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
      return failureOf(error);
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
    root: stateRoot,
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
  const released: Lease[] = [];
  const notHeld: string[] = [];
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
  BOARD_TOOL.board_budget_set,
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
      turnLimit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Tokens a single turn of the bean may cost'),
      sessionLimit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Tokens a single session of the bean may cost'),
    },
  },
  async (input) => {
    try {
      const budget = setBudget(db, {
        bean: input.bean,
        tokenLimit: input.tokenLimit,
        ...(input.stopAt !== undefined ? { stopAt: input.stopAt } : {}),
        ...(input.turnLimit !== undefined ? { turnLimit: input.turnLimit } : {}),
        ...(input.sessionLimit !== undefined ? { sessionLimit: input.sessionLimit } : {}),
      });
      await appendAudit(auditPath, {
        policyId: POLICIES.budgetSet.id,
        policyVersion: POLICIES.budgetSet.version,
        // The board cannot verify who is calling it, so the audit records the
        // role the tool is for rather than a name that was never checked.
        actor: 'lead',
        action: 'budget_set',
        resource: input.bean,
        effect: 'allow',
        detail: `limit ${budget.tokenLimit}, stop at ${budget.stopAt}`,
      });
      return text(budget);
    } catch (error) {
      return failureOf(error);
    }
  },
);

/**
 * Check one bean's budget, and put the decision on the record.
 *
 * The verdict is the ledger's: the cap is in the board and the usage is
 * measured there (§6.7). The self-report is still recorded, because the old
 * clients still send it, but the check above did not need it.
 */
async function checkOneBudget(bean: string, tokensUsed: number): Promise<BudgetDecision> {
  const decision = checkBudget(db, bean, tokensUsed, usageReaders);

  if (decision.configured) {
    recordUsage(db, bean, tokensUsed);
    await appendAudit(auditPath, {
      policyId: POLICIES.budgetUsage.id,
      policyVersion: POLICIES.budgetUsage.version,
      actor: 'builder',
      action: 'budget_usage',
      resource: bean,
      effect: 'allow',
      detail: `self-reported ${tokensUsed} tokens; deprecated, the ledger measures the usage`,
    });
  }

  if (decision.warning !== undefined) {
    await appendAudit(auditPath, {
      policyId: POLICIES.budgetWarn.id,
      policyVersion: POLICIES.budgetWarn.version,
      actor: 'builder',
      action: 'budget_check',
      resource: bean,
      effect: 'ask',
      detail: decision.warning,
    });
  }

  if (decision.stop) {
    await appendAudit(auditPath, {
      policyId: POLICIES.budgetStop.id,
      policyVersion: POLICIES.budgetStop.version,
      // The caller is not known to the board, so the bean is the subject of
      // the record and the actor is the role the tool serves.
      actor: 'builder',
      action: 'budget_check',
      resource: bean,
      effect: 'deny',
      detail: `${decision.tokensUsed} tokens used, stop at ${decision.stopAt}`,
    });
  }

  if (decision.turnStop || decision.sessionStop) {
    await appendAudit(auditPath, {
      policyId: POLICIES.budgetStop.id,
      policyVersion: POLICIES.budgetStop.version,
      actor: 'builder',
      action: 'budget_check',
      resource: bean,
      effect: 'deny',
      detail: decision.turnStop
        ? `a turn cost ${decision.turnTokens ?? 0} tokens, over its cap of ${decision.turnLimit ?? 0}`
        : `a session cost ${decision.sessionTokens ?? 0} tokens, over its cap of ${decision.sessionLimit ?? 0}`,
    });
  }

  return decision;
}

server.registerTool(
  BOARD_TOOL.board_budget,
  {
    description:
      'The token budgets on the board. op=check reports whether a bean is over its budget and records the usage; at 85 percent the builder stops and posts a blocker. op=list lists the budgets. The self-reported usage is deprecated: the ledger measures the usage and the check reads it there, so a self-report is ignored by the check.',
    inputSchema: {
      op: z.enum(['check', 'list']).describe('What this call does'),
      bean: z.string().optional().describe('check: the bean to check'),
      tokensUsed: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          'check: the tokens spent so far. Deprecated: the ledger measures the usage and the check reads it there, so this self-report is ignored by the check.',
        ),
    },
  },
  async (input) => {
    try {
      if (input.op === 'check') {
        const bean = required(input.bean, 'bean');
        return text(await checkOneBudget(bean, input.tokensUsed ?? 0));
      }

      const budgets = listBudgets(db).map((budget) => ({
        ...budget,
        // The split the check reads: the measured number is the ledger's,
        // the self-report is the deprecated one the check ignores.
        measured: usageReaders.total?.(budget.bean),
      }));
      return text({ budgets });
    } catch (error) {
      return failureOf(error);
    }
  },
);

// --- classification ---------------------------------------------------------

/**
 * Classify a request into the dispatch profiles.
 *
 * The Lead has to decide how much of the system a request deserves before it
 * spawns anything, and that decision decides the token spend. A System One
 * model answers it with a probability for each profile and a confidence, so
 * the Lead can take the cheaper plan when it is not sure.
 *
 * The tool is advisory. Without a key, or with the service down, it says so
 * and the Lead classifies the request itself.
 */
server.registerTool(
  BOARD_TOOL.board_lease_revoke,
  {
    description:
      'Take a lease away from an agent that is not using it any more, for example a session that died holding it. The Lead only; every other role has this tool denied by name. A lease is otherwise only ever released by the agent that holds it, so a dead session holds its files until the Lead revokes them.',
    inputSchema: {
      glob: z.string().describe('The path glob to take back'),
    },
  },
  async (input) => {
    try {
      const result = revokeLease(db, { glob: required(input.glob, 'glob') });
      if (result.lease) {
        await appendAudit(auditPath, {
          policyId: POLICIES.leaseRevoke.id,
          policyVersion: POLICIES.leaseRevoke.version,
          actor: 'lead',
          action: 'lease_revoke',
          resource: result.lease.glob,
          effect: 'allow',
          detail: `taken from ${result.lease.agent} on bean ${result.lease.bean}`,
        });
      }
      return text(result);
    } catch (error) {
      return failureOf(error);
    }
  },
);

server.registerTool(
  BOARD_TOOL.board_classify,
  {
    description:
      'Classify a request into the dispatch profiles, with the probability of each and the confidence. The Lead calls this before it spawns anything, and takes the cheaper plan when the confidence is low. Without a System One key it says so, and the Lead classifies the request itself.',
    inputSchema: {
      request: z.string().describe('The request, as the human phrased it'),
      profiles: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          'The profiles to classify into, each with what it covers. The default is the four dispatch profiles.',
        ),
    },
  },
  async (input) => {
    try {
      const profiles = input.profiles ?? dispatchProfileCriteria();
      if (!isJevAvailable()) {
        return text({
          available: false,
          reason:
            'no System One key is configured, so no decision was made. Set TYPESAFE_API_KEY in the environment, or classify the request yourself.',
          profiles: Object.keys(profiles),
        });
      }

      const client = createJevClient();
      const outcome = await client.systemOne({
        state: { request: input.request },
        questions: {
          dispatch: choice('How should this request be handled by the agent team?', profiles),
        },
      });

      if (!outcome.ok) {
        return text({ available: false, reason: outcome.reason });
      }

      const answer = outcome.response.answers.dispatch;
      if (answer === undefined || answer.type !== 'choice') {
        return text({
          available: false,
          reason: 'the System One answer was not a choice, so no decision was made.',
        });
      }

      return text({
        available: true,
        model: outcome.response.model,
        profile: answer.choice,
        confidence: answer.confidence,
        probabilities: answer.probabilities,
        usage: outcome.response.usage,
      });
    } catch (error) {
      return failureOf(error);
    }
  },
);
const transport = new StdioServerTransport();
await server.connect(transport);

/** Report on stderr: stdout belongs to the MCP transport. */
function reportRotation(message: string): void {
  process.stderr.write(`${message}\n`);
}

// The audit log is appended by every decision and has no other owner, so it
// grows without a bound. Rotation runs after the server is serving: nothing
// waits for it, and a rotation that fails is reported and swallowed, never
// taking the board down. Only the audit log and its numbered archives under
// `.openagentsy` are touched; the board database, the records, the leases,
// and every file outside that directory are never touched.
void rotateAudit(auditPath)
  .then((result) => {
    if (result.error !== undefined) {
      reportRotation(`audit rotation skipped: ${result.error}`);
      return;
    }
    if (!result.rotated) return;
    const dropped = result.dropped === undefined ? '' : `, dropped ${result.dropped}`;
    reportRotation(
      `audit rotated: ${result.movedLines} lines (${result.movedBytes} bytes) to ${result.archive}${dropped}`,
    );
  })
  .catch((error: unknown) => {
    reportRotation(
      `audit rotation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
