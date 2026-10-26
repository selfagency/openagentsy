import { z } from 'zod';
import { repairJson } from './repair.js';
import type { LocalBackend, OffloadJob, OffloadUsage } from './types.js';

/** A local model that has not answered in this long is treated as absent. */
export const DEFAULT_TIMEOUT_MS = 20_000;

export interface OffloadOptions {
  /** How long to wait for the backend. The default is 20 seconds. */
  timeoutMs?: number;
}

/** The answer shape of Ollama's chat protocol. */
interface OllamaAnswer {
  message?: { content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
}

/** The answer shape of the OpenAI-compatible protocol. */
interface OpenAiAnswer {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Ask a local model to do a housekeeping job.
 *
 * The router never throws and never retries: an unreachable backend, a
 * backend that answers with an error, an answer that does not fit the schema
 * and a model that runs out of words all come back as `undefined`, and the
 * caller falls back to what it would have done anyway. There is one repair
 * attempt and no more, because a loop over a slow local model burns the
 * user's time for nothing.
 */
export async function offload<T>(
  job: OffloadJob<T>,
  be: LocalBackend,
  onUsage: (usage: OffloadUsage) => void,
  options: OffloadOptions = {},
): Promise<T | undefined> {
  const started = performance.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const jsonSchema = jsonSchemaOf(job.schema);
  if (jsonSchema === undefined) return undefined;
  const body = requestBody(job, be, jsonSchema);
  const url = be.kind === 'ollama' ? `${be.baseUrl}/api/chat` : `${be.baseUrl}/v1/chat/completions`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(() => undefined);
  if (!response?.ok) return undefined;

  const answer = (await response.json().catch(() => undefined)) as
    | OllamaAnswer
    | OpenAiAnswer
    | undefined;
  if (!answer) return undefined;

  const text = answerText(be, answer);

  // The answer as it came, then the answer after one repair. Nothing else.
  for (const candidate of [text ?? '', repairJson(text ?? '')]) {
    const parsed = parse(job.schema, candidate);
    if (parsed === undefined) continue;
    report(onUsage, {
      job: job.name,
      seconds: (performance.now() - started) / 1000,
      inTok: tokensIn(be, answer),
      outTok: tokensOut(be, answer),
    });
    return parsed;
  }
  return undefined;
}

/**
 * The JSON schema of the job. A schema that cannot be represented in JSON
 * Schema - a custom type, a transform, a date - is a job that cannot be
 * asked, so the job comes back as nothing and the caller falls back.
 */
function jsonSchemaOf(schema: z.ZodType<unknown>): unknown | undefined {
  try {
    return z.toJSONSchema(schema);
  } catch {
    return undefined;
  }
}

/**
 * Tell the caller what the job cost. The answer is already parsed, so a
 * callback that throws loses its own failure and not the answer: the
 * caller's bookkeeping must not decide whether the work happened.
 */
function report(onUsage: (usage: OffloadUsage) => void, usage: OffloadUsage): void {
  try {
    onUsage(usage);
  } catch {
    // The answer is what the caller came for.
    return;
  }
}

/** The request each protocol expects. */
function requestBody<T>(
  job: OffloadJob<T>,
  be: LocalBackend,
  jsonSchema: unknown,
): Record<string, unknown> {
  const messages = [{ role: 'user', content: job.prompt }];
  if (be.kind === 'ollama') {
    return {
      model: be.model,
      stream: false,
      format: jsonSchema,
      messages,
      options: { num_predict: job.maxTokens },
    };
  }
  return {
    model: be.model,
    max_tokens: job.maxTokens,
    messages,
    response_format: { type: 'json_schema', json_schema: { name: job.name, schema: jsonSchema } },
  };
}

/** The text of the answer, whichever protocol it came in. */
function answerText(be: LocalBackend, answer: OllamaAnswer | OpenAiAnswer): string | undefined {
  if (be.kind === 'ollama') return (answer as OllamaAnswer).message?.content;
  return (answer as OpenAiAnswer).choices?.[0]?.message?.content;
}

/** Parse the answer and hold it to the schema. A broken answer is not an error. */
function parse<T>(schema: z.ZodType<T>, text: string): T | undefined {
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Ollama counts the prompt, the OpenAI protocol counts the prompt. */
function tokensIn(be: LocalBackend, answer: OllamaAnswer | OpenAiAnswer): number {
  if (be.kind === 'ollama') return (answer as OllamaAnswer).prompt_eval_count ?? 0;
  return (answer as OpenAiAnswer).usage?.prompt_tokens ?? 0;
}

/** Ollama counts the answer, the OpenAI protocol counts the answer. */
function tokensOut(be: LocalBackend, answer: OllamaAnswer | OpenAiAnswer): number {
  if (be.kind === 'ollama') return (answer as OllamaAnswer).eval_count ?? 0;
  return (answer as OpenAiAnswer).usage?.completion_tokens ?? 0;
}
