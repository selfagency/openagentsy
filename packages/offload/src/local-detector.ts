import type { LocalBackendKind } from './types.js';

/** The local model servers this package knows how to find. */
export type LocalProduct = 'ollama' | 'lmstudio' | 'apfel' | 'jan' | 'localai' | 'vllm';

/** One server to probe, and how to read the models it holds. */
export interface DetectorTarget {
  /** Which product the server is. */
  product: LocalProduct;
  /** The protocol the server speaks. */
  kind: LocalBackendKind;
  /** Where the server listens. */
  baseUrl: string;
  /** The path that proves the server is there. */
  probePath: string;
  /** The path that lists the models, when the probe does not carry them. */
  modelsPath?: string;
  /** The shape of the model list in the answer. */
  list: 'ollama' | 'openai';
}

/**
 * The six servers the plan's revision 3 asks for, on their default ports.
 *
 * Apfel and Ollama share port 11434, so only one of the two can answer. The
 * probe for Apfel is its own `/health`, which Ollama does not serve, so a
 * model list is never labelled with the wrong product.
 */
export const DEFAULT_TARGETS: readonly DetectorTarget[] = [
  // Ollama: default port 11434, GET /api/tags lists the installed models.
  // https://docs.ollama.com/api
  {
    product: 'ollama',
    kind: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    probePath: '/api/tags',
    list: 'ollama',
  },
  // LM Studio: default port 1234, the OpenAI-compatible /v1/models.
  // https://lmstudio.ai/docs/app/api
  {
    product: 'lmstudio',
    kind: 'lmstudio',
    baseUrl: 'http://127.0.0.1:1234',
    probePath: '/v1/models',
    list: 'openai',
  },
  // Apfel: Apple's on-device model behind an OpenAI-compatible server on the
  // default port 11434, with its own /health and the model list on /v1/models.
  // https://github.com/Arthur-Ficial/apfel/blob/main/docs/openai-api-compatibility.md
  {
    product: 'apfel',
    kind: 'lmstudio',
    baseUrl: 'http://127.0.0.1:11434',
    probePath: '/health',
    modelsPath: '/v1/models',
    list: 'openai',
  },
  // Jan: default port 1337, API prefix /v1.
  // https://docs.jan.ai/desktop/api-server
  {
    product: 'jan',
    kind: 'lmstudio',
    baseUrl: 'http://127.0.0.1:1337',
    probePath: '/v1/models',
    list: 'openai',
  },
  // LocalAI: default port 8080, the OpenAI-compatible /v1/models.
  // https://localai.io/docs/basics/getting_started/
  {
    product: 'localai',
    kind: 'lmstudio',
    baseUrl: 'http://127.0.0.1:8080',
    probePath: '/v1/models',
    list: 'openai',
  },
  // vLLM: default port 8000, the OpenAI-compatible /v1/models.
  // https://docs.vllm.ai/en/latest/serving/online_serving/
  {
    product: 'vllm',
    kind: 'lmstudio',
    baseUrl: 'http://127.0.0.1:8000',
    probePath: '/v1/models',
    list: 'openai',
  },
];

/** A backend that answered, with the model to ask it. */
export interface DetectedBackend {
  /** The protocol the server speaks. */
  kind: LocalBackendKind;
  /** Which product the server is. */
  product: LocalProduct;
  /** Where the server listens. */
  baseUrl: string;
  /** The model to ask. */
  model: string;
}

export interface DetectOptions {
  /** The servers to probe. The default is the six above. */
  targets?: readonly DetectorTarget[];
  /** How long a probe may take. The default is two seconds. */
  timeoutMs?: number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

/**
 * Find the local model servers that are running. With none, the list is
 * empty and offloading is skipped - nothing breaks, because a local model is
 * an optimisation and never a dependency.
 */
export async function detectLocalBackends(options: DetectOptions = {}): Promise<DetectedBackend[]> {
  const targets = options.targets ?? DEFAULT_TARGETS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const found = await Promise.all(targets.map((target) => probe(target, timeoutMs)));
  return found.flat();
}

/** Ask one server what it has. A server that does not answer is skipped. */
async function probe(target: DetectorTarget, timeoutMs: number): Promise<DetectedBackend[]> {
  const present = await answers(`${target.baseUrl}${target.probePath}`, timeoutMs);
  if (!present) return [];

  const modelsPath = target.modelsPath ?? target.probePath;
  const answer =
    modelsPath === target.probePath
      ? present
      : await answers(`${target.baseUrl}${modelsPath}`, timeoutMs);
  if (!answer) return [];

  const models = target.list === 'ollama' ? ollamaModels(answer) : openAiModels(answer);
  return models.map((model) => ({
    kind: target.kind,
    product: target.product,
    baseUrl: target.baseUrl,
    model,
  }));
}

/** The probe itself. It never throws: a refused connection is an answer. */
async function answers(url: string, timeoutMs: number): Promise<unknown | undefined> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) }).catch(
    () => undefined,
  );
  if (!response?.ok) return undefined;
  return response.json().catch(() => undefined);
}

/** Ollama names its models `name`. */
function ollamaModels(answer: unknown): string[] {
  const models = (answer as { models?: { name?: string }[] }).models;
  if (!Array.isArray(models)) return [];
  return models
    .map((model) => model?.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
}

/** The OpenAI protocol names its models `id`. */
function openAiModels(answer: unknown): string[] {
  const data = (answer as { data?: { id?: string }[] }).data;
  if (!Array.isArray(data)) return [];
  return data
    .map((model) => model?.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}
