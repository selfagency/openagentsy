import { describe, expect, it } from 'vitest';
import { DEFAULT_TARGETS, type DetectorTarget, detectLocalBackends } from './local-detector.js';
import { startStubServer } from './test-support/http.js';

describe('the local backend detector', () => {
  it('probes the six local servers on their documented ports', () => {
    expect(DEFAULT_TARGETS).toHaveLength(6);
    expect(DEFAULT_TARGETS.map((target) => target.product)).toEqual([
      'ollama',
      'lmstudio',
      'apfel',
      'jan',
      'localai',
      'vllm',
    ]);
    expect(DEFAULT_TARGETS.map((target) => new URL(target.baseUrl).port)).toEqual([
      '11434',
      '1234',
      '11434',
      '1337',
      '8080',
      '8000',
    ]);
  });

  it('detects an ollama backend and the models it holds', async () => {
    const server = await startStubServer((request) => {
      if (request.path === '/api/tags') {
        return { body: JSON.stringify({ models: [{ name: 'llama3:8b' }, { name: 'qwen3:4b' }] }) };
      }
      return { status: 404, body: '{}' };
    });
    try {
      const targets: DetectorTarget[] = [
        {
          product: 'ollama',
          kind: 'ollama',
          baseUrl: server.baseUrl,
          probePath: '/api/tags',
          list: 'ollama',
        },
      ];
      const found = await detectLocalBackends({ targets });
      expect(found).toEqual([
        { kind: 'ollama', product: 'ollama', baseUrl: server.baseUrl, model: 'llama3:8b' },
        { kind: 'ollama', product: 'ollama', baseUrl: server.baseUrl, model: 'qwen3:4b' },
      ]);
    } finally {
      server.close();
    }
  });

  it('detects an openai-compatible backend', async () => {
    const server = await startStubServer((request) => {
      if (request.path === '/v1/models') {
        return { body: JSON.stringify({ data: [{ id: 'qwen3' }] }) };
      }
      return { status: 404, body: '{}' };
    });
    try {
      const targets: DetectorTarget[] = [
        {
          product: 'vllm',
          kind: 'lmstudio',
          baseUrl: server.baseUrl,
          probePath: '/v1/models',
          list: 'openai',
        },
      ];
      const found = await detectLocalBackends({ targets });
      expect(found).toEqual([
        { kind: 'lmstudio', product: 'vllm', baseUrl: server.baseUrl, model: 'qwen3' },
      ]);
    } finally {
      server.close();
    }
  });

  it('reads the models from a second path when the probe path does not carry them', async () => {
    const server = await startStubServer((request) => {
      if (request.path === '/health') return { body: JSON.stringify({ status: 'ok' }) };
      if (request.path === '/v1/models')
        return { body: JSON.stringify({ data: [{ id: 'apple-foundationmodel' }] }) };
      return { status: 404, body: '{}' };
    });
    try {
      const targets: DetectorTarget[] = [
        {
          product: 'apfel',
          kind: 'lmstudio',
          baseUrl: server.baseUrl,
          probePath: '/health',
          modelsPath: '/v1/models',
          list: 'openai',
        },
      ];
      const found = await detectLocalBackends({ targets });
      expect(found).toEqual([
        {
          kind: 'lmstudio',
          product: 'apfel',
          baseUrl: server.baseUrl,
          model: 'apple-foundationmodel',
        },
      ]);
    } finally {
      server.close();
    }
  });

  it('finds nothing when no backend answers', async () => {
    const server = await startStubServer(() => ({ body: '{}' }));
    const baseUrl = server.baseUrl;
    server.close();
    const targets: DetectorTarget[] = [
      { product: 'ollama', kind: 'ollama', baseUrl, probePath: '/api/tags', list: 'ollama' },
    ];
    expect(await detectLocalBackends({ targets, timeoutMs: 500 })).toEqual([]);
  });

  it('finds nothing when the answer carries no models', async () => {
    const server = await startStubServer(() => ({ body: JSON.stringify({ models: [] }) }));
    try {
      const targets: DetectorTarget[] = [
        {
          product: 'ollama',
          kind: 'ollama',
          baseUrl: server.baseUrl,
          probePath: '/api/tags',
          list: 'ollama',
        },
      ];
      expect(await detectLocalBackends({ targets })).toEqual([]);
    } finally {
      server.close();
    }
  });
});
