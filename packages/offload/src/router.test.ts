import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { offload } from './router.js';
import { startStubServer } from './test-support/http.js';
import type { LocalBackend, OffloadUsage } from './types.js';

const titleSchema = z.object({ title: z.string().max(60) });

const ollama = (baseUrl: string): LocalBackend => ({ kind: 'ollama', baseUrl, model: 'llama3' });
const openAi = (baseUrl: string): LocalBackend => ({ kind: 'lmstudio', baseUrl, model: 'qwen3' });

const job = { name: 'title', prompt: 'Title this', schema: titleSchema, maxTokens: 64 };

describe('the router', () => {
  it('asks the ollama backend in its own protocol', async () => {
    const server = await startStubServer(() => ({
      body: JSON.stringify({
        message: { content: '{"title":"Hello"}' },
        prompt_eval_count: 12,
        eval_count: 5,
      }),
    }));
    try {
      const usage: OffloadUsage[] = [];
      const result = await offload(job, ollama(server.baseUrl), (u) => usage.push(u));

      expect(result).toEqual({ title: 'Hello' });
      const request = server.requests[0];
      expect(request?.method).toBe('POST');
      expect(request?.path).toBe('/api/chat');
      const body = JSON.parse(request?.body ?? '{}');
      expect(body.model).toBe('llama3');
      expect(body.stream).toBe(false);
      expect(body.options.num_predict).toBe(64);
      expect(body.messages[0].content).toBe('Title this');
      expect(body.format.properties.title.maxLength).toBe(60);
      expect(usage).toEqual([{ job: 'title', seconds: expect.any(Number), inTok: 12, outTok: 5 }]);
    } finally {
      server.close();
    }
  });

  it('asks an openai-compatible backend for a json_schema answer', async () => {
    const server = await startStubServer(() => ({
      body: JSON.stringify({
        choices: [{ message: { content: '{"title":"Hello"}' } }],
        usage: { prompt_tokens: 7, completion_tokens: 3 },
      }),
    }));
    try {
      const usage: OffloadUsage[] = [];
      const result = await offload(job, openAi(server.baseUrl), (u) => usage.push(u));

      expect(result).toEqual({ title: 'Hello' });
      const request = server.requests[0];
      expect(request?.path).toBe('/v1/chat/completions');
      const body = JSON.parse(request?.body ?? '{}');
      expect(body.model).toBe('qwen3');
      expect(body.max_tokens).toBe(64);
      expect(body.messages[0].content).toBe('Title this');
      expect(body.response_format.type).toBe('json_schema');
      expect(body.response_format.json_schema.name).toBe('title');
      expect(body.response_format.json_schema.schema.properties.title.maxLength).toBe(60);
      expect(usage).toEqual([{ job: 'title', seconds: expect.any(Number), inTok: 7, outTok: 3 }]);
    } finally {
      server.close();
    }
  });

  it('repairs one truncated answer', async () => {
    const server = await startStubServer(() => ({
      body: JSON.stringify({ message: { content: '{"title": "Hello wor' } }),
    }));
    try {
      const usage: OffloadUsage[] = [];
      const result = await offload(job, ollama(server.baseUrl), (u) => usage.push(u));

      expect(result).toEqual({ title: 'Hello wor' });
      expect(usage).toHaveLength(1);
    } finally {
      server.close();
    }
  });

  it('repairs one answer with a trailing comma', async () => {
    const server = await startStubServer(() => ({
      body: JSON.stringify({ choices: [{ message: { content: '{"title":"Hello",}' } }] }),
    }));
    try {
      expect(await offload(job, openAi(server.baseUrl), () => undefined)).toEqual({
        title: 'Hello',
      });
    } finally {
      server.close();
    }
  });

  it('gives up after the repair fails', async () => {
    const server = await startStubServer(() => ({
      body: JSON.stringify({ message: { content: 'I am not JSON' } }),
    }));
    try {
      const usage: OffloadUsage[] = [];
      expect(await offload(job, ollama(server.baseUrl), (u) => usage.push(u))).toBeUndefined();
      expect(usage).toEqual([]);
    } finally {
      server.close();
    }
  });

  it('gives up when the answer does not fit the schema', async () => {
    const server = await startStubServer(() => ({
      body: JSON.stringify({ message: { content: '{"title":42}' } }),
    }));
    try {
      expect(await offload(job, ollama(server.baseUrl), () => undefined)).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('returns nothing when the backend answers with an error', async () => {
    const server = await startStubServer(() => ({ status: 500, body: 'boom' }));
    try {
      expect(await offload(job, ollama(server.baseUrl), () => undefined)).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('returns nothing when the backend is unreachable', async () => {
    const server = await startStubServer(() => ({ body: '{}' }));
    const baseUrl = server.baseUrl;
    server.close();
    expect(await offload(job, ollama(baseUrl), () => undefined)).toBeUndefined();
  });

  it('returns nothing when the backend does not answer in time', async () => {
    const server = await startStubServer(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      return { body: JSON.stringify({ message: { content: '{"title":"Late"}' } }) };
    });
    try {
      const usage: OffloadUsage[] = [];
      const result = await offload(job, ollama(server.baseUrl), (u) => usage.push(u), {
        timeoutMs: 50,
      });
      expect(result).toBeUndefined();
      expect(usage).toEqual([]);
    } finally {
      server.close();
    }
  });
});
