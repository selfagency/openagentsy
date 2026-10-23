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
  revokeLease,
  setBudget,
} from '@openagentsy/core';
import { choice, createJevClient, isJevAvailable } from '@openagentsy/jev';
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
    const roles = await loadRoles(join(root, 'roles.yaml'));
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
- board_budget: the token budgets. op=check reports whether a bean is over its budget; at 85 percent the builder stops and posts a blocker. op=list lists the budgets.
- board_budget_set: set a token budget for a bean. The Lead only.
- board_classify: classify a request into the dispatch profiles, with the probability of each. The Lead calls it before it spawns anything.
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
            // The caller is not known to the board, so the bean is the subject
            // of the record and the actor is the role the tool serves.
            actor: 'builder',
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
  'board_lease_revoke',
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
      return failure(error);
    }
  },
);

server.registerTool(
  'board_classify',
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
      return failure(error);
    }
  },
);
const transport = new StdioServerTransport();
await server.connect(transport);
