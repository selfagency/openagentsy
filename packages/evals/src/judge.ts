import { createJevClient, type JevClient, noul } from '@openagentsy/jev';
import {
  type HarnessClient,
  type HarnessMessage,
  type IdleRegistry,
  parseModel,
  TRIAL_BUDGET_MS,
  waitForIdle,
} from './opencode.js';

/**
 * The probability at which a System One answer counts as met.
 *
 * The judge that reads a conversation is a model, and a model that cannot
 * tell says so. A System One model answers the same question with the
 * probability that it is true, and a probability clears a bar. The bar is
 * high on purpose: a case that was not decided must not pass on a hunch.
 */
const MET_AT = 0.7;

/** The probability at which a System One answer counts as not met. */
const NOT_MET_AT = 0.3;
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
  /** The client the judge asks. */
  client: HarnessClient;
  /**
   * The idle events the event stream carried.
   *
   * The judge waits for its turn to end, and the stream of the case says
   * when the turn of a session is over.
   */
  idle: IdleRegistry;
  /** The directory the judge's session lives in. */
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
  /** How long the judge's turn may take, in milliseconds. */
  timeoutMs?: number;
};

/**
 * The judge, running on the user's own providers.
 *
 * The OpenCode server has no OpenAI compatible endpoint, so the judge is
 * another session on the same server, with the judge agent. The judge agent
 * has no tools and answers with one JSON object.
 */
export async function judge(options: JudgeOptions): Promise<Verdict> {
  const { client, directory, idle } = options;

  const sessionID = await client.createSession({ title: 'eval judge', directory });

  // The judge agent carries its own instructions, in its file. A system
  // prompt in the body would replace them, and the Console refuses a request
  // that carries one: the free tier only answers requests that came from
  // inside OpenCode, and the override is a path that arrives without the
  // mark of one.
  const question = [
    'The criteria:',
    ...options.criteria.map((c, index) => `${index + 1}. ${c}`),
    '',
    'The conversation:',
    '',
    options.transcript,
    '',
    options.evidence ? `The state the session left behind:\n\n${options.evidence}` : '',
  ].join('\n');

  // The turn is asked for in the background and the answer is read out of
  // the session when the turn ends. OpenCode 2 has no prompt that waits for
  // the answer, and the wait is the same on both runtimes.
  idle.beginTurn(sessionID);
  await client.prompt({
    sessionID,
    directory,
    agent: 'judge',
    model: parseModel(options.model),
    text: question,
  });
  await waitForIdle({
    client,
    sessionID,
    directory,
    timeoutMs: options.timeoutMs ?? TRIAL_BUDGET_MS,
    idle,
  });

  const messages = await client.messages({ sessionID, directory });
  const text = replyOf(messages);

  if (text.trim() === '') {
    // The provider's refusal lands on the message, not on the response, so
    // an empty answer means the model never ran. Say which refusal it was.
    const error = providerRefusal(messages.at(-1));
    throw new Error(`the judge answered with nothing${error === undefined ? '' : `: ${error}`}`);
  }

  const verdict = parseVerdict(text, options.criteria);
  return breakTies(verdict, {
    transcript: options.transcript,
    criteria: options.criteria,
    ...(options.evidence !== undefined ? { evidence: options.evidence } : {}),
  });
}

/**
 * What a probability says about one criterion.
 *
 * The bar is high on purpose: a criterion that was not decided must not pass
 * on a hunch, and it must not fail on one either. A probability in the middle
 * is still undecided.
 */
export function verdictFromProbability(criterion: string, probability: number): CriterionVerdict {
  const reason = `the probability was ${probability.toFixed(2)}`;
  if (probability >= MET_AT) return { criterion, status: 'met', reason };
  if (probability <= NOT_MET_AT) return { criterion, status: 'not-met', reason };
  return { criterion, status: 'inconclusive', reason };
}

/**
 * Decide the criteria the judge could not.
 *
 * A judge that reads a conversation is a model, and a model that cannot tell
 * says so. A System One model answers the same question with the probability
 * that it is true, so an undecided criterion gets a number instead of a shrug.
 *
 * The number has to clear a bar to change the verdict. Without a key, or
 * with the service down, the verdict is the one the judge gave.
 */
export async function breakTies(
  verdict: Verdict,
  options: {
    transcript: string;
    evidence?: string | undefined;
    criteria?: readonly string[] | undefined;
    client?: JevClient | undefined;
  },
): Promise<Verdict> {
  // Only a criterion the case asked about can be tied. A criterion that came
  // from the judge's own words is not one of them, and a name that is not a
  // criterion at all must never become a key in a request.
  const known = options.criteria;
  const isKnown = (criterion: string): boolean => known === undefined || known.includes(criterion);

  const undecided = verdict.criteria.filter(
    (entry) => entry.status === 'inconclusive' && isKnown(entry.criterion),
  );
  if (undecided.length === 0) return verdict;

  // The client is the one that decides whether a tie can be broken, and the
  // key is what decides that. A caller that passes a client decides both.
  const client = options.client ?? createJevClient();
  if (!client.available) return verdict;

  // The questions are keyed by criterion, and a criterion is untrusted text.
  // A null-prototype object keeps a name like __proto__ from reaching the
  // prototype of the request.
  const questions: Record<string, { type: 'noul'; instructions: string }> = Object.create(
    null,
  ) as Record<string, { type: 'noul'; instructions: string }>;
  for (const entry of undecided) {
    Object.defineProperty(questions, entry.criterion, {
      value: noul(entry.criterion),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  const outcome = await client.systemOne({
    state: {
      conversation: options.transcript,
      ...(options.evidence !== undefined ? { evidence: options.evidence } : {}),
    },
    questions,
  });
  if (!outcome.ok) return verdict;

  const criteria = verdict.criteria.map((entry) => {
    if (entry.status !== 'inconclusive') return entry;
    if (!Object.hasOwn(outcome.response.answers, entry.criterion)) return entry;
    const answer = outcome.response.answers[entry.criterion];
    if (answer === undefined || answer.type !== 'noul') return entry;
    return verdictFromProbability(entry.criterion, answer.noul);
  });

  return { ...summarize(criteria), criteria };
}

/**
 * The judge's answer, from the session's own messages.
 *
 * The prompt is answered in the background, so the answer is in the session
 * when the turn ends, and the session's own messages are the source of
 * truth.
 */
function replyOf(messages: readonly HarnessMessage[]): string {
  const last = messages.at(-1);
  return (last?.parts ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n');
}

/**
 * What the provider said, when it refused the judge's turn.
 *
 * The refusal lands on the message, not on the response, so the status and
 * the message of the error say which provider and which budget refused.
 */
function providerRefusal(message: HarnessMessage | undefined): string | undefined {
  const error = message?.info.error;
  if (error === undefined) return undefined;
  const status = error.data?.statusCode;
  const text = error.message ?? '';
  if (status === undefined) return text === '' ? undefined : text;
  return text === ''
    ? `the provider answered ${status}`
    : `the provider answered ${status}: ${text}`;
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
