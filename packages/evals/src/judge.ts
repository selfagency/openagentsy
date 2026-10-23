import type { OpencodeClient } from '@opencode-ai/sdk';
import { parseModel } from './opencode.js';

/**
 * What the judge concluded about one criterion.
 *
 * `inconclusive` is a real answer: the judge could not tell from the
 * evidence it was given. It is kept apart from `not-met` because a case
 * that failed because the judge could not see is a different failure from a
 * case that failed because the agent did the wrong thing.
 */
export type CriterionStatus = 'met' | 'not-met' | 'inconclusive';

export type CriterionVerdict = {
  criterion: string;
  status: CriterionStatus;
  reason: string;
};

export type Verdict = {
  /** True when every criterion was met. */
  pass: boolean;
  /** True when no criterion failed but at least one could not be decided. */
  inconclusive: boolean;
  reason: string;
  criteria: CriterionVerdict[];
};

export type JudgeOptions = {
  client: OpencodeClient;
  directory: string;
  /** The model that judges. It should be a different family from the one under test. */
  model: string;
  /** The criteria the conversation is judged against. */
  criteria: string[];
  /** The conversation. */
  transcript: string;
  /**
   * The state the conversation left behind: the board records, the audit log
   * and the tool calls.
   *
   * A criterion the state cannot show is judged on the conversation. A
   * criterion the state does show is judged on the state, because the state
   * is what happened and the conversation is what was said.
   */
  evidence?: string;
};

/**
 * The judge, running on the user's own providers.
 *
 * The OpenCode server has no OpenAI compatible endpoint, so the judge is
 * another session on the same server, with the judge agent. The judge agent
 * has no tools and answers with one JSON object.
 */
export async function judge(options: JudgeOptions): Promise<Verdict> {
  const { client, directory } = options;

  const created = await client.session.create({
    body: { title: 'eval judge' },
    query: { directory },
  });
  if (created.error) {
    throw new Error(`could not create the judge session: ${JSON.stringify(created.error)}`);
  }

  const prompted = await client.session.prompt({
    path: { id: created.data?.id },
    body: {
      agent: 'judge',
      model: parseModel(options.model),
      system: [
        'You judge how an agent CONDUCTED itself in a conversation. You do not judge whether the code in the conversation works.',
        'The agent under test may be a reviewer that is forbidden from fixing anything: a failing test it reports is a success, not a failure.',
        'Judge each criterion on its own, against the evidence you are given, and against nothing else.',
        '',
        'The criteria:',
        ...options.criteria.map((c, index) => `${index + 1}. ${c}`),
        '',
        'Answer with one JSON object and nothing else, no prose, no code fence:',
        '{"criteria": [{"criterion": "the criterion text", "status": "met" | "not-met" | "inconclusive", "reason": "one sentence"}]}',
        '',
        'One entry per criterion, in the order the criteria are listed.',
        'A criterion is met only if the evidence shows it. If the evidence does not show it, it did not happen.',
        'A criterion is inconclusive when the evidence cannot decide it, which is different from evidence showing it did not happen.',
        'When two criteria point different ways, the run fails.',
      ].join('\n'),
      parts: [
        {
          type: 'text',
          text: [
            'The conversation:',
            '',
            options.transcript,
            '',
            options.evidence ? `The state the session left behind:\n\n${options.evidence}` : '',
          ].join('\n'),
        },
      ],
    },
    query: { directory },
  });

  if (prompted.error) {
    throw new Error(`the judge failed: ${JSON.stringify(prompted.error)}`);
  }

  const text = await replyOf(client, created.data?.id, directory, prompted.data?.parts);

  if (text.trim() === '') {
    // The provider's refusal lands on the message, not on the response, so
    // an empty answer means the model never ran. Say which refusal it was.
    const error = prompted.data?.info?.error;
    throw new Error(
      `the judge answered with nothing${
        error === undefined ? '' : `: ${JSON.stringify(error).slice(0, 300)}`
      }`,
    );
  }

  return parseVerdict(text, options.criteria);
}

/**
 * The judge's answer, from wherever it landed.
 *
 * A prompt that streams can come back with its parts empty, so the session's
 * own messages are the source of truth; the response is the fallback.
 */
async function replyOf(
  client: OpencodeClient,
  sessionID: string | undefined,
  directory: string,
  parts: { type: string }[] | undefined,
): Promise<string> {
  if (sessionID !== undefined) {
    const messages = await client.session.messages({
      path: { id: sessionID },
      query: { directory },
    });
    const last = messages.data?.at(-1);
    const text = (last?.parts ?? [])
      .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    if (text.trim() !== '') return text;
  }

  return (parts ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => (part as unknown as { text: string }).text)
    .join('\n');
}

/**
 * The status the judge gave, or inconclusive when it gave none it can be read as.
 */
function statusOf(value: unknown): CriterionStatus {
  if (value === 'met' || value === 'not-met' || value === 'inconclusive') return value;
  return 'inconclusive';
}

/**
 * The verdict on one criterion.
 *
 * A criterion the judge left out is inconclusive: the judge was asked about
 * it and did not decide it. That is not the same as a criterion the judge
 * decided was not met.
 */
function verdictFor(criterion: string, entries: readonly unknown[]): CriterionVerdict {
  const entry = entries.find((item) => {
    if (typeof item !== 'object' || item === null) return false;
    const text = (item as { criterion?: unknown }).criterion;
    return typeof text === 'string' && text.trim() === criterion.trim();
  });
  if (entry === undefined) {
    return { criterion, status: 'inconclusive', reason: 'the judge did not decide it' };
  }
  const record = entry as { status?: unknown; reason?: unknown };
  return {
    criterion,
    status: statusOf(record.status),
    reason: typeof record.reason === 'string' ? record.reason : '',
  };
}

/**
 * What the verdicts mean for the case.
 *
 * A case fails when a criterion was not met. A case with no failure and an
 * undecided criterion is inconclusive, which is reported apart from a
 * failure: a case that failed because the judge could not see is a different
 * failure from a case that failed because the agent did the wrong thing.
 */
function summarize(verdicts: CriterionVerdict[]): {
  pass: boolean;
  inconclusive: boolean;
  reason: string;
} {
  const failed = verdicts.filter((entry) => entry.status === 'not-met');
  const undecided = verdicts.filter((entry) => entry.status === 'inconclusive');
  return {
    pass: failed.length === 0 && undecided.length === 0,
    inconclusive: failed.length === 0 && undecided.length > 0,
    reason: failed[0]?.reason ?? undecided[0]?.reason ?? 'every criterion was met',
  };
}

/**
 * Read the verdict out of the judge's answer, whatever it wrapped it in.
 *
 * The judge answers with one entry per criterion. A criterion it left out is
 * inconclusive: the judge was asked about it and did not decide it.
 */
export function parseVerdict(text: string, criteria: string[]): Verdict {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error(`the judge did not answer with an object: ${text.slice(0, 200)}`);
  }
  const parsed: unknown = JSON.parse(text.slice(start, end + 1));
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('the judge answered with something that is not an object');
  }
  const raw = (parsed as { criteria?: unknown }).criteria;
  const entries = Array.isArray(raw) ? raw : [];

  const verdicts = criteria.map((criterion) => verdictFor(criterion, entries));
  return { ...summarize(verdicts), criteria: verdicts };
}
