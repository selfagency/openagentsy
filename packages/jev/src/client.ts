import {
  type ChoiceQuestion,
  type JevQuestion,
  type JevState,
  type NoulQuestion,
  type ScoreQuestion,
  type SystemOneRequest,
  type SystemOneResponse,
  systemOneResponseSchema,
} from './types.js';

/**
 * The client for a System One model.
 *
 * The client never throws. A decision that cannot be made is a result the
 * caller has to handle, because the caller is usually an agent that has to
 * carry on without the answer.
 *
 * The official TypeSafe SDK is not used: it reads the response body twice in
 * its fetch path, which Bun refuses ("Body already used"), and this project
 * runs on Bun everywhere.
 */

export const DEFAULT_ENDPOINT = 'https://api.typesafe.ai';
/**
 * The model the client asks.
 *
 * The alias `jev-latest` moves, and a tie-breaker with fixed thresholds has
 * to ask the same model the thresholds were measured against: a change of
 * model is a change of calibration, and the bars would mean something else.
 */
export const DEFAULT_MODEL = 'jev-1.14.0';
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_RETRIES = 2;

/**
 * The environment variable that points the client at another endpoint.
 *
 * It exists so a test can answer without the network, and so a project can
 * put a proxy in front of the service.
 */
export const ENDPOINT_ENV = 'OPENAGENTSY_JEV_ENDPOINT';

export type JevClientOptions = {
  /** The API key. It falls back to the environment. */
  apiKey?: string | undefined;
  endpoint?: string | undefined;
  model?: string | undefined;
  /** The fetch to use. It exists so a test can answer without a network. */
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
  /** How many times a rate limited or overloaded call is tried again. */
  retries?: number | undefined;
};

/**
 * Whether a System One model can be reached.
 *
 * The key comes from the environment and never from the repository. A
 * project without the key is a project without a classifier, and every
 * caller has to work without one.
 */
export function isJevAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  const key = env.TYPESAFE_API_KEY;
  return typeof key === 'string' && key.trim().length > 0;
}

export type JevOutcome = { ok: true; response: SystemOneResponse } | { ok: false; reason: string };

export type JevClient = {
  /** Ask the model to answer the questions about the state. */
  systemOne(input: {
    state: JevState;
    questions: Record<string, JevQuestion>;
  }): Promise<JevOutcome>;
  /** The model this client asks. */
  model: string;
  /** Whether the client has a key to call with. */
  available: boolean;
};

/**
 * Build a client.
 *
 * A client without a key is a client that says it cannot answer, and says
 * so without calling anything.
 */
export function createJevClient(options: JevClientOptions = {}): JevClient {
  const apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY;
  const endpoint = options.endpoint ?? process.env[ENDPOINT_ENV] ?? DEFAULT_ENDPOINT;
  const model = options.model ?? DEFAULT_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const available = typeof apiKey === 'string' && apiKey.trim().length > 0;

  const send = async (body: SystemOneRequest): Promise<Response> =>
    fetchImpl(`${endpoint}/v1/systemone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey ?? ''}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

  const systemOne = async (input: {
    state: JevState;
    questions: Record<string, JevQuestion>;
  }): Promise<JevOutcome> => {
    if (!available) {
      return {
        ok: false,
        reason:
          'no System One key is configured, so no decision was made. Set TYPESAFE_API_KEY in the environment to use one.',
      };
    }
    if (Object.keys(input.questions).length === 0) {
      return { ok: false, reason: 'a request needs at least one question.' };
    }

    const body: SystemOneRequest = { model, state: input.state, questions: input.questions };

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const outcome = await attemptOnce(send, body, attempt, retries);
      if (outcome.kind === 'answer') return { ok: true, response: outcome.response };
      if (outcome.kind === 'failure') return { ok: false, reason: outcome.reason };
      await sleep(outcome.waitMs);
    }

    return { ok: false, reason: 'the System One call was not answered.' };
  };

  return { systemOne, model, available };
}

/**
 * What one attempt at the call produced.
 *
 * `retry` is the only answer that is not the end of it: the service was
 * rate limited or overloaded, and another attempt is worth making.
 */
type Attempt =
  | { kind: 'answer'; response: SystemOneResponse }
  | { kind: 'retry'; waitMs: number }
  | { kind: 'failure'; reason: string };

/**
 * One attempt at the call.
 *
 * A rate limit or an overloaded service is worth another try. Anything else
 * is the request's own problem and will not fix itself.
 */
async function attemptOnce(
  send: (body: SystemOneRequest) => Promise<Response>,
  body: SystemOneRequest,
  attempt: number,
  retries: number,
): Promise<Attempt> {
  let response: Response;
  try {
    response = await send(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (attempt < retries) return { kind: 'retry', waitMs: backoffMs(attempt) };
    return { kind: 'failure', reason: `the System One call failed: ${message}` };
  }

  if (response.ok) return readAnswer(response);

  if ((response.status === 429 || response.status === 529) && attempt < retries) {
    return { kind: 'retry', waitMs: retryAfterMs(response, attempt) };
  }

  const detail = await errorDetail(response);
  if (response.status === 401) {
    return {
      kind: 'failure',
      reason: `the System One key was refused: ${detail}. Check TYPESAFE_API_KEY.`,
    };
  }
  return {
    kind: 'failure',
    reason: `the System One call failed with ${response.status}: ${detail}`,
  };
}

/**
 * Read the answer, and hold it to the contract.
 *
 * An answer that does not fit the schema is an error, not a value to be
 * used: the whole point of a typed decision is that the code can branch on
 * it.
 */
async function readAnswer(response: Response): Promise<Attempt> {
  const text = await response.text();
  const parsed = systemOneResponseSchema.safeParse(safeJson(text));
  if (!parsed.success) {
    return {
      kind: 'failure',
      reason: `the System One answer did not fit the contract: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
    };
  }
  return { kind: 'answer', response: parsed.data };
}

/** A noul question, for the case where the caller wants a boolean. */
export function noul(instructions: string): NoulQuestion {
  return { type: 'noul', instructions };
}

/** A choice question, for the case where the caller wants one of a set. */
export function choice(instructions: string, criteria: Record<string, string>): ChoiceQuestion {
  return { type: 'choice', instructions, criteria };
}

/** A score question, for the case where the caller wants a rating. */
export function score(instructions: string, criteria: string[]): ScoreQuestion {
  return { type: 'score', instructions, criteria };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function errorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 300);
  } catch {
    return response.statusText;
  }
}

function backoffMs(attempt: number): number {
  return 250 * 2 ** attempt;
}

function retryAfterMs(response: Response, attempt: number): number {
  const header = response.headers.get('retry-after');
  const seconds = header === null ? Number.NaN : Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 5_000);
  return backoffMs(attempt);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
