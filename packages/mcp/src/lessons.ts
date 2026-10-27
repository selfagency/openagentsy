import {
  captureCandidate,
  decideLesson,
  type EvalResult,
  isOwner,
  type LessonState,
  type Owner,
  type StartPacket,
} from '@openagentsy/hooks';
import { z } from 'zod';

/**
 * The lesson tools.
 *
 * Two tools, and the split between them is the point:
 *
 * - `oa_lesson_propose` is for agents. It records what the archivist saw, and
 *   it proposes; it never decides.
 * - `oa_lesson_decide` is for a person. The permission map denies it to every
 *   agent role, and the command a person runs calls the same code, so the
 *   decision has one implementation and one audit trail.
 *
 * The module exports the definitions. The server registers them, the way it
 * registers the board tools.
 */

/** The tool names, for the base-tool vocabulary. */
export const LESSON_TOOL_NAMES = ['oa_lesson_propose', 'oa_lesson_decide'] as const;

/** What an MCP tool answers with. */
export type LessonToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

/** The answer, as JSON. */
function text(value: unknown): LessonToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/** The failure, as JSON, with the next step. */
function failure(reason: string, hint: string): LessonToolResult {
  return {
    content: [{ type: 'text', text: `${reason}\n\nNext: ${hint}` }],
    isError: true,
  };
}

const proposeArgs = z.object({
  summary: z.string().min(1).describe('What happened, in one sentence'),
  kind: z.string().min(1).describe('The waste kind'),
  detail: z.string().min(1).describe('The detail of the waste'),
  session: z.string().min(1).describe('The session it was seen in'),
  explicitCorrection: z
    .boolean()
    .optional()
    .describe('Whether a person corrected the agent outright, which is a lesson at once'),
  evidence: z.array(z.string()).optional().describe('The evidence the lesson rests on'),
  owner: z
    .string()
    .optional()
    .describe(
      'The narrowest owner: test:<name>, validator:<name>, skill:<name>, role:<name>, instructions or memory',
    ),
  ownerJustification: z
    .string()
    .optional()
    .describe('Why code or a skill cannot hold the lesson. Needed for instructions and memory'),
  futureBehavior: z.string().optional().describe('What the agent should do differently next time'),
  representativeTask: z
    .string()
    .optional()
    .describe('One concrete scenario that should now succeed'),
  writeBoundary: z.array(z.string()).optional().describe('The files the change may touch'),
  proof: z.string().optional().describe('The path to an eval artifact, or to an evals/ suite'),
});

const evalResultArgs = z.object({
  schema_version: z.literal('1'),
  lesson_id: z.string(),
  artifact_sha256: z.string(),
  started_at: z.string(),
  finished_at: z.string(),
  passed: z.boolean(),
  runs: z.number().int().min(1),
  scenarios: z.array(
    z.object({
      id: z.string(),
      phase: z.enum(['baseline', 'candidate']),
      command_sha256: z.string(),
      exit_code: z.number().int().nullable(),
      timed_out: z.boolean(),
      duration_ms: z.number().int(),
      assertions: z.record(z.string(), z.boolean()),
      passed: z.boolean(),
    }),
  ),
});

const decideArgs = z.object({
  id: z.string().min(1).describe('The lesson the decision is about'),
  action: z
    .enum(['validate', 'apply', 'reject', 'observe'])
    .describe('What was decided about the lesson'),
  decidedBy: z.string().min(1).describe('Who decided. A person, never an agent'),
  reason: z.string().min(1).describe('Why'),
  changeRef: z.string().optional().describe('The commit or the change the decision names'),
  outcome: z
    .enum(['rolled_back', 'superseded', 'open_question'])
    .optional()
    .describe('The state an observation lands in, when the default is not wanted'),
  evalResult: evalResultArgs
    .optional()
    .describe('The proof the decision rests on: the content of the result file'),
});

/** The two tools, each with the shape of its own arguments. */
export type LessonToolDefs = {
  oa_lesson_propose: {
    description: string;
    inputSchema: typeof proposeArgs.shape;
    handler: (input: z.infer<typeof proposeArgs>) => Promise<LessonToolResult>;
  };
  oa_lesson_decide: {
    description: string;
    inputSchema: typeof decideArgs.shape;
    handler: (input: z.infer<typeof decideArgs>) => Promise<LessonToolResult>;
  };
};

/**
 * The tools, defined once.
 *
 * The root is the state root the lessons live under, the same root the
 * board uses.
 */
export function createLessonTools(root: string): LessonToolDefs {
  return {
    oa_lesson_propose: {
      description:
        'Propose a lesson: record a waste the archivist saw. The same waste kind with a similar detail in three or more sessions becomes a candidate, and an explicit correction becomes one at once. Proposing is not deciding: the permission map keeps every agent role away from the decision tool.',
      inputSchema: proposeArgs.shape,
      async handler(input) {
        if (input.owner !== undefined && !isOwner(input.owner)) {
          return failure(
            `"${input.owner}" is not an owner`,
            'an owner is test:<name>, validator:<name>, skill:<name>, role:<name>, instructions or memory',
          );
        }
        const packet: Partial<StartPacket> = {
          ...(input.futureBehavior === undefined ? {} : { futureBehavior: input.futureBehavior }),
          ...(input.representativeTask === undefined
            ? {}
            : { representativeTask: input.representativeTask }),
          ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
          ...(input.owner === undefined ? {} : { owner: input.owner as Owner }),
          ...(input.ownerJustification === undefined
            ? {}
            : { ownerJustification: input.ownerJustification }),
          ...(input.writeBoundary === undefined ? {} : { writeBoundary: input.writeBoundary }),
          ...(input.proof === undefined ? {} : { proof: input.proof }),
        };
        const outcome = await captureCandidate(root, {
          summary: input.summary,
          observations: [{ kind: input.kind, detail: input.detail, session: input.session }],
          ...(input.explicitCorrection === undefined
            ? {}
            : { explicitCorrection: input.explicitCorrection }),
          ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
          packet,
        });
        if (!outcome.ok) {
          return text({
            created: false,
            reason: outcome.reason,
            sessions: outcome.sessions,
            needed: 'the same waste in three or more sessions, or an explicit correction',
            redactions: outcome.redactions,
          });
        }
        return text({
          id: outcome.lesson.id,
          created: outcome.created,
          state: outcome.lesson.state,
          occurrences: outcome.lesson.occurrences,
          sessions: outcome.lesson.sessions.length,
          redactions: outcome.redactions,
        });
      },
    },

    oa_lesson_decide: {
      description:
        'Decide on a lesson: validate it, apply it, reject it, or record what was observed. A person decides, and the permission map denies this tool to every agent role.',
      inputSchema: decideArgs.shape,
      async handler(input) {
        const evalResult = input.evalResult as EvalResult | undefined;
        const outcome = await decideLesson(root, {
          id: input.id,
          action: input.action,
          decidedBy: input.decidedBy,
          reason: input.reason,
          ...(evalResult === undefined ? {} : { evalResult }),
          ...(input.changeRef === undefined ? {} : { changeRef: input.changeRef }),
          ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
        });
        if (!outcome.ok) return failure(outcome.reason, outcome.hint);
        return text({
          id: outcome.lesson.id,
          state: outcome.lesson.state as LessonState,
          occurrences: outcome.lesson.occurrences,
          history: outcome.lesson.history.length,
        });
      },
    },
  };
}
