import type { ProviderId } from './types.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class ProviderError extends Error {
  readonly hint: string;

  constructor(message: string, hint: string) {
    super(message);
    this.name = 'ProviderError';
    this.hint = hint;
  }
}

async function getJson<T>(url: string, fetchImpl: FetchLike): Promise<T> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new ProviderError(
      `${url} returned ${response.status}`,
      'check the network and the provider credentials, then run the command again',
    );
  }
  return (await response.json()) as T;
}

/** The models an OpenCode provider actually serves. */
export async function listOpenCodeModels(
  provider: 'opencode' | 'opencode-go',
  fetchImpl: FetchLike = fetch,
): Promise<string[]> {
  const base =
    provider === 'opencode-go'
      ? 'https://opencode.ai/inference/go/v1/models'
      : 'https://opencode.ai/inference/v1/models';
  const payload = await getJson<{ data: { id: string }[] }>(base, fetchImpl);
  return payload.data.map((model) => model.id);
}

export type OllamaModel = {
  name: string;
  capabilities: string[];
  parameterSize?: string;
};

export type OllamaTags = {
  models: {
    name: string;
    details?: { parameter_size?: string };
    capabilities?: string[];
  }[];
};

/** The models an Ollama instance serves, local or cloud. */
export async function listOllamaModels(
  baseUrl: string,
  fetchImpl: FetchLike = fetch,
): Promise<OllamaModel[]> {
  const payload = await getJson<OllamaTags>(`${baseUrl.replace(/\/$/, '')}/api/tags`, fetchImpl);
  return payload.models.map((model) => ({
    name: model.name,
    capabilities: model.capabilities ?? [],
    ...(model.details?.parameter_size !== undefined
      ? { parameterSize: model.details.parameter_size }
      : {}),
  }));
}

export type ProviderSelection = {
  provider: ProviderId;
  baseUrl?: string;
};

export const OLLAMA_CLOUD_URL = 'https://ollama.com';

/** Turn a provider selection into the model ids it serves. */
export async function listProviderModels(
  selection: ProviderSelection,
  fetchImpl: FetchLike = fetch,
): Promise<OllamaModel[] | string[]> {
  if (selection.provider === 'opencode' || selection.provider === 'opencode-go') {
    return listOpenCodeModels(selection.provider, fetchImpl);
  }
  const baseUrl =
    selection.baseUrl ??
    (selection.provider === 'ollama-cloud' ? OLLAMA_CLOUD_URL : 'http://localhost:11434');
  return listOllamaModels(baseUrl, fetchImpl);
}
