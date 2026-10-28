import type { z } from 'zod';

/**
 * The two protocols a local model server speaks.
 *
 * 'ollama' is Ollama's own chat protocol. 'lmstudio' is the OpenAI-compatible
 * protocol, which LM Studio, Jan, LocalAI, vLLM and Apfel all serve - the
 * name is the plan's, the protocol is the OpenAI one.
 */
export type LocalBackendKind = 'ollama' | 'lmstudio';

/** A local model server and the model to ask. */
export interface LocalBackend {
  kind: LocalBackendKind;
  baseUrl: string;
  model: string;
}

/** What one offloaded job cost. The caller decides what to do with it. */
export interface OffloadUsage {
  /** The name of the job, as the caller named it. */
  job: string;
  /** How long the answer took, in seconds. */
  seconds: number;
  /** The tokens the backend read. */
  inTok: number;
  /** The tokens the backend wrote. */
  outTok: number;
}

/** One housekeeping job: a prompt, the shape of the answer, and its budget. */
export interface OffloadJob<T> {
  /** The name of the job. It goes into the usage record and the schema name. */
  name: string;
  /** The prompt that is sent to the local model. */
  prompt: string;
  /** The shape the answer must have. */
  schema: z.ZodType<T>;
  /** The token budget for the answer. */
  maxTokens: number;
}
