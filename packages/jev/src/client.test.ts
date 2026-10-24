import { describe, expect, it } from 'vitest';
import { choice, createJevClient, isJevAvailable, noul } from './client.js';

const KEY = 'test-key';

/** A fetch that answers with the given responses, one per call. */
function fakeFetch(
  responses: { status: number; body: string; headers?: Record<string, string> }[],
) {
  const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
  let index = 0;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const response = responses[index];
    index += 1;
    if (response === undefined) throw new Error('the fake fetch ran out of answers');
    return new Response(response.body, {
      status: response.status,
      headers: response.headers ?? { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const CHOICE_BODY = JSON.stringify({
  model: 'jev-1.14.0',
  answers: {
    routing: {
      type: 'choice',
      choice: 'solo',
      confidence: 0.99,
      probabilities: { solo: 0.99, fanout_read: 0.01 },
    },
  },
  usage: { input_tokens: 397, output_tokens: 67 },
});

describe('isJevAvailable', () => {
  it('is available when the key is set', () => {
    expect(isJevAvailable({ TYPESAFE_API_KEY: 'k' })).toBe(true);
  });

  it('is not available without the key', () => {
    expect(isJevAvailable({})).toBe(false);
    expect(isJevAvailable({ TYPESAFE_API_KEY: '  ' })).toBe(false);
  });
});

describe('the client', () => {
  it('sends the key, the state and the questions', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: CHOICE_BODY }]);
    const client = createJevClient({ apiKey: KEY, fetchImpl: impl });

    const outcome = await client.systemOne({
      state: { request: 'fix a typo' },
      questions: { routing: choice('How should this be handled?', { solo: 'one agent' }) },
    });

    expect(outcome.ok).toBe(true);
    const call = calls[0];
    expect(call?.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(call?.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(call?.body).toEqual({
      model: 'jev-1.14.0',
      state: { request: 'fix a typo' },
      questions: {
        routing: {
          type: 'choice',
          instructions: 'How should this be handled?',
          criteria: { solo: 'one agent' },
        },
      },
    });
  });

  it('reads a choice answer', async () => {
    const { impl } = fakeFetch([{ status: 200, body: CHOICE_BODY }]);
    const client = createJevClient({ apiKey: KEY, fetchImpl: impl });

    const outcome = await client.systemOne({ state: 'x', questions: { routing: noul('is it?') } });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.response.model).toBe('jev-1.14.0');
    expect(outcome.response.usage.input_tokens).toBe(397);
    const answer = outcome.response.answers.routing;
    expect(answer?.type).toBe('choice');
    if (answer?.type !== 'choice') return;
    expect(answer.choice).toBe('solo');
    expect(answer.confidence).toBe(0.99);
    expect(answer.probabilities.solo).toBe(0.99);
  });

  it('reads a noul answer', async () => {
    const body = JSON.stringify({
      model: 'jev-1.14.0',
      answers: { held: { type: 'noul', noul: 0.03 } },
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    const { impl } = fakeFetch([{ status: 200, body }]);
    const client = createJevClient({ apiKey: KEY, fetchImpl: impl });

    const outcome = await client.systemOne({
      state: 'x',
      questions: { held: noul('did it hold?') },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const answer = outcome.response.answers.held;
    expect(answer?.type).toBe('noul');
    if (answer?.type !== 'noul') return;
    expect(answer.noul).toBe(0.03);
  });

  it('says it cannot answer when there is no key', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: CHOICE_BODY }]);
    const client = createJevClient({ apiKey: '', fetchImpl: impl });

    const outcome = await client.systemOne({ state: 'x', questions: { held: noul('?') } });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain('TYPESAFE_API_KEY');
    expect(calls).toHaveLength(0);
  });

  it('refuses a request with no questions', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: CHOICE_BODY }]);
    const client = createJevClient({ apiKey: KEY, fetchImpl: impl });

    const outcome = await client.systemOne({ state: 'x', questions: {} });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain('at least one question');
    expect(calls).toHaveLength(0);
  });

  it('tries again when the service is overloaded', async () => {
    const { impl, calls } = fakeFetch([
      { status: 529, body: '{}' },
      { status: 200, body: CHOICE_BODY },
    ]);
    const client = createJevClient({ apiKey: KEY, fetchImpl: impl, retries: 2 });

    const outcome = await client.systemOne({ state: 'x', questions: { held: noul('?') } });
    expect(outcome.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('tries again when the rate limit is hit', async () => {
    const { impl, calls } = fakeFetch([
      { status: 429, body: '{}', headers: { 'retry-after': '0' } },
      { status: 200, body: CHOICE_BODY },
    ]);
    const client = createJevClient({ apiKey: KEY, fetchImpl: impl, retries: 2 });

    const outcome = await client.systemOne({ state: 'x', questions: { held: noul('?') } });
    expect(outcome.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('gives up after the retries are spent', async () => {
    const { impl, calls } = fakeFetch([
      { status: 529, body: '{}' },
      { status: 529, body: '{}' },
      { status: 529, body: '{}' },
    ]);
    const client = createJevClient({ apiKey: KEY, fetchImpl: impl, retries: 2 });

    const outcome = await client.systemOne({ state: 'x', questions: { held: noul('?') } });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain('529');
    expect(calls).toHaveLength(3);
  });

  it('names the key problem when the key is refused', async () => {
    const { impl } = fakeFetch([{ status: 401, body: '{"detail":"bad key"}' }]);
    const client = createJevClient({ apiKey: KEY, fetchImpl: impl, retries: 0 });

    const outcome = await client.systemOne({ state: 'x', questions: { held: noul('?') } });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain('TYPESAFE_API_KEY');
  });

  it('refuses an answer that does not fit the contract', async () => {
    const { impl } = fakeFetch([
      {
        status: 200,
        body: JSON.stringify({ model: 'jev-1.14.0', answers: { a: { type: 'guess' } } }),
      },
    ]);
    const client = createJevClient({ apiKey: KEY, fetchImpl: impl, retries: 0 });

    const outcome = await client.systemOne({ state: 'x', questions: { held: noul('?') } });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain('did not fit the contract');
  });

  it('reports a call that never reached the service', async () => {
    const impl = (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;
    const client = createJevClient({ apiKey: KEY, fetchImpl: impl, retries: 0 });

    const outcome = await client.systemOne({ state: 'x', questions: { held: noul('?') } });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain('connection refused');
  });
});
