import { readFileSync } from 'node:fs';
import type { OpencodeClient } from '@opencode-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  type HarnessClient,
  permissionRequestOf,
  replyPartsOf,
  V1HarnessClient,
  V2HarnessClient,
} from './opencode.js';
import type { V2Transport } from './v2client.js';

/**
 * The harness on an OpenCode 2 server.
 *
 * The bodies under `fixtures/v2` were captured from a live OpenCode 2.2.0
 * server on 2026-10-27, so the readers are measured against what the server
 * really sent and not against what its schema says it sends.
 */
function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/v2/${name}`, import.meta.url), 'utf8');
}

/** One request the client made. */
type Call = {
  method: string;
  url: string;
  body?: string;
};

/** A transport that answers with canned bodies and keeps the calls. */
function fake(answer: (call: Call) => Response | Promise<Response>): {
  transport: V2Transport;
  calls: Call[];
} {
  const calls: Call[] = [];
  const transport: V2Transport = {
    request: async (url, init) => {
      const call: Call = { method: init.method, url };
      if (init.body !== undefined) call.body = init.body;
      calls.push(call);
      return answer(call);
    },
  };
  return { transport, calls };
}

/** A JSON answer. */
function json(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

/** The path of a call, without the query it carries. */
function pathOf(call: Call): string {
  return new URL(call.url).pathname;
}

/** A client of an OpenCode 2 server, over a transport that answers. */
function v2(answer: (call: Call) => Response | Promise<Response>): {
  client: HarnessClient;
  calls: Call[];
} {
  const fakeTransport = fake(answer);
  return {
    client: new V2HarnessClient({
      baseUrl: 'http://127.0.0.1:4096',
      transport: fakeTransport.transport,
    }),
    calls: fakeTransport.calls,
  };
}

/** The directory every case of the suite lives in. */
const DIRECTORY = '/case';

describe('the harness on OpenCode 2', () => {
  it('reads the messages of a session in the shape the harness reads', async () => {
    const { client } = v2(() => json(fixture('messages-assistant.json')));

    const messages = await client.messages({ sessionID: 'ses_abc', directory: DIRECTORY });

    // The user message is flat on the server and flat here: its text is on
    // the message and it has no parts.
    expect(messages[0]?.info.role).toBe('user');
    expect(messages[0]?.parts[0]).toEqual({
      type: 'text',
      text: 'Use the bash tool to run: echo hello-there. Then reply DONE.',
    });
    // The assistant message carries the error of the turn.
    expect(messages[1]?.info.role).toBe('assistant');
    expect(messages[1]?.info.error?.data?.statusCode).toBe(403);
    // The idle message is the server's way of saying the turn is over, and
    // the harness has no message for it.
    expect(messages).toHaveLength(2);
  });

  it('reads the tool calls of an assistant message', async () => {
    // The captured turn ended in a provider error, so its assistant message
    // carries no parts. The tool part is built from the server's own schema:
    // a tool part has a name and a state with the arguments of the call.
    const body = JSON.stringify({
      data: [
        {
          id: 'msg_assistant',
          time: { created: 2, completed: 3 },
          type: 'assistant',
          agent: 'build',
          content: [
            { type: 'text', text: 'I will run it.' },
            {
              type: 'tool',
              id: 't1',
              name: 'bash',
              state: { status: 'completed', input: { command: 'echo hi' } },
            },
          ],
        },
        { id: 'msg_user', time: { created: 1 }, text: 'run it', type: 'user' },
      ],
    });
    const { client } = v2(() => json(body));

    const messages = await client.messages({ sessionID: 'ses_abc', directory: DIRECTORY });

    const reply = replyPartsOf(messages);
    expect(reply.text).toBe('I will run it.');
    expect(reply.toolCalls).toEqual([{ tool: 'bash', input: { command: 'echo hi' } }]);
  });

  it('finds the board server in the list of MCP servers', async () => {
    // The captured list holds one connected server and one failed server, and
    // neither of them is the board.
    const { client } = v2(() => json(fixture('mcp-servers.json')));

    expect(await client.boardStatus({ directory: DIRECTORY })).toBeUndefined();
  });

  it('reads the state of the board server, which is an object on the 2.x server', async () => {
    const body = JSON.stringify({
      location: { directory: DIRECTORY },
      data: [
        { name: 'openagentsy', status: { status: 'connected' } },
        { name: 'probe', status: { status: 'failed', error: 'Connection closed' } },
      ],
    });
    const { client } = v2(() => json(body));

    expect(await client.boardStatus({ directory: DIRECTORY })).toEqual({ status: 'connected' });
  });

  it('reads the busy map, which is a map on the 2.x server', async () => {
    const { client } = v2(() => json(fixture('session-active.json')));

    expect(await client.busySessions({ directory: DIRECTORY })).toEqual(new Set());
  });

  it('reads the sessions of a directory, with the parent of a dispatched child', async () => {
    const body = JSON.stringify({
      data: [
        { id: 'ses_lead', title: 'eval agentsy' },
        { id: 'ses_child', title: 'Write hello.txt', parentID: 'ses_lead' },
      ],
    });
    const { client } = v2(() => json(body));

    const sessions = await client.listSessions({ directory: DIRECTORY });

    expect(sessions).toEqual([
      { id: 'ses_lead', title: 'eval agentsy' },
      { id: 'ses_child', title: 'Write hello.txt', parentID: 'ses_lead' },
    ]);
  });

  it('attaches the agent and sets the model of the session before it asks', async () => {
    // The prompt body of the 2.x server carries no model and does not pick
    // the agent: the model of a turn is the model of its session, and so is
    // the agent of a turn.
    const { client, calls } = v2((call) => {
      if (pathOf(call).endsWith('/model') || pathOf(call).endsWith('/agent')) {
        return new Response(null, { status: 204 });
      }
      return json(fixture('prompt-response.json'));
    });

    await client.prompt({
      sessionID: 'ses_abc',
      directory: DIRECTORY,
      agent: 'agentsy',
      model: { providerID: 'ollama-cloud', modelID: 'minimax-m3.1-flash' },
      text: 'the question',
    });

    expect(calls.map(pathOf)).toEqual([
      '/api/session/ses_abc/agent',
      '/api/session/ses_abc/model',
      '/api/session/ses_abc/prompt',
    ]);
    expect(calls[0]?.body).toBe('{"agent":"agentsy"}');
    expect(calls[1]?.body).toBe(
      '{"model":{"id":"minimax-m3.1-flash","providerID":"ollama-cloud"}}',
    );
    expect(calls[2]?.body).toBe('{"text":"the question","agents":[{"name":"agentsy"}]}');
  });

  it('answers a permission request with the decision the server reads', async () => {
    const { client, calls } = v2(() => new Response(null, { status: 204 }));

    await client.replyPermission({
      sessionID: 'ses_abc',
      permissionID: 'per_1',
      directory: DIRECTORY,
      decision: 'reject',
    });

    expect(pathOf(calls[0] ?? { method: '', url: '' })).toBe(
      '/api/session/ses_abc/permission/per_1/reply',
    );
    expect(calls[0]?.body).toBe('{"decision":"reject"}');
  });

  it('deletes a session that answers 204 with an empty body', async () => {
    const { client, calls } = v2(() => new Response(null, { status: 204 }));

    await expect(
      client.deleteSession({ sessionID: 'ses_abc', directory: DIRECTORY }),
    ).resolves.toBeUndefined();
    expect(calls[0]?.method).toBe('DELETE');
  });

  it('yields the events of the stream with their payload', async () => {
    const { client } = v2(
      () =>
        new Response(fixture('events.sse'), {
          headers: { 'content-type': 'text/event-stream' },
        }),
    );

    const stream = await client.events({ directory: DIRECTORY });
    const seen: { type: string; sessionID?: string }[] = [];
    for await (const event of stream) {
      const data = event.data as { sessionID?: string } | undefined;
      seen.push({
        type: event.type,
        ...(data?.sessionID !== undefined ? { sessionID: data.sessionID } : {}),
      });
    }

    expect(seen[0]?.type).toBe('server.connected');
    // The event that says a session started its work names the session.
    expect(seen.some((event) => event.sessionID !== undefined)).toBe(true);
  });
});

describe('the permission request of an event', () => {
  it('reads the request of an OpenCode 1 event', () => {
    const request = permissionRequestOf({
      type: 'permission.updated',
      properties: {
        id: 'per_1',
        sessionID: 'ses_abc',
        title: 'Edit roles.yaml',
        type: 'edit',
        pattern: 'roles.yaml',
      },
    });

    expect(request).toEqual({
      sessionID: 'ses_abc',
      permissionID: 'per_1',
      title: 'Edit roles.yaml',
      type: 'edit',
      patterns: ['roles.yaml'],
    });
  });

  it('reads the request of an OpenCode 2 event', () => {
    const request = permissionRequestOf({
      type: 'permission.asked',
      data: {
        id: 'per_1',
        sessionID: 'ses_abc',
        action: 'edit',
        resources: ['roles.yaml'],
        message: 'Edit roles.yaml',
      },
    });

    expect(request).toEqual({
      sessionID: 'ses_abc',
      permissionID: 'per_1',
      title: 'Edit roles.yaml',
      type: 'edit',
      patterns: ['roles.yaml'],
    });
  });

  it('says nothing about an event that is not a request', () => {
    expect(
      permissionRequestOf({ type: 'session.idle', data: { sessionID: 'ses_abc' } }),
    ).toBeUndefined();
  });

  it('says nothing about a tool call, which carries an id of its own', () => {
    // The measured failure (2026-10-27): the 2.x stream carries the id of
    // every tool call next to the session id, and a reader that takes any
    // event with an id and a session id answers a permission that was never
    // asked. The server refuses the id of a tool call as a permission id.
    expect(
      permissionRequestOf({
        type: 'session.tool.progress',
        data: { id: 'call_function_abc_1', sessionID: 'ses_abc' },
      }),
    ).toBeUndefined();
  });
});

/**
 * The same contract on both runtimes.
 *
 * The harness asks the same questions of both servers, and the two answer
 * them in different words. The two clients below are given the two answers
 * the two servers really send, and the assertions are the same for both.
 */
describe('the same contract on both runtimes', () => {
  /** The answer of a 1.x server: the message and the parts the SDK sends. */
  const V1_MESSAGES = {
    data: [
      {
        info: { role: 'assistant', time: { completed: 3 } },
        parts: [{ type: 'text', text: 'the answer' }],
      },
    ],
  };

  /** The answer of a 2.x server: the union of tagged messages. */
  const V2_MESSAGES = {
    data: [
      { id: 'm3', time: { created: 3 }, type: 'idle', outcome: 'succeeded' },
      {
        id: 'm2',
        time: { created: 2, completed: 3 },
        type: 'assistant',
        agent: 'build',
        content: [{ type: 'text', text: 'the answer' }],
      },
      { id: 'm1', time: { created: 1 }, text: 'the question', type: 'user' },
    ],
  };

  /** A client of a 1.x server, over the SDK's own API. */
  function v1(): HarnessClient {
    const client = {
      session: {
        create: async () => ({ data: { id: 'ses_case' } }),
        promptAsync: async () => ({}),
        messages: async () => V1_MESSAGES,
        status: async () => ({ data: { ses_busy: {} } }),
        list: async () => ({ data: [{ id: 'ses_child', title: 'a child', parentID: 'ses_case' }] }),
        abort: async () => ({}),
        delete: async () => ({ data: true }),
      },
      mcp: { status: async () => ({ data: { openagentsy: { status: 'connected' } } }) },
      event: { subscribe: async () => ({ stream: (async function* () {})() }) },
      postSessionIdPermissionsPermissionId: async () => ({}),
    } as unknown as OpencodeClient;
    return new V1HarnessClient(client);
  }

  /** A client of a 2.x server, over the API of the 2.x server. */
  function v2(): HarnessClient {
    const { client } = v2Client((call) => {
      const path = pathOf(call);
      if (path === '/api/session' && call.method === 'POST') {
        return json(fixture('session-create.json'));
      }
      if (path === '/api/session' && call.method === 'GET') {
        return json(
          JSON.stringify({
            data: [{ id: 'ses_child', title: 'a child', parentID: 'ses_case' }],
          }),
        );
      }
      if (path.endsWith('/message')) return json(JSON.stringify(V2_MESSAGES));
      if (path === '/api/session/active') {
        return json(JSON.stringify({ data: { ses_busy: { id: 'ses_busy' } } }));
      }
      if (path === '/api/mcp') {
        return json(
          JSON.stringify({
            location: { directory: DIRECTORY },
            data: [{ name: 'openagentsy', status: { status: 'connected' } }],
          }),
        );
      }
      return json(JSON.stringify({ data: [] }));
    });
    return client;
  }

  /** A client of a 2.x server, over a transport that answers. */
  function v2Client(answer: (call: Call) => Response | Promise<Response>): {
    client: HarnessClient;
    calls: Call[];
  } {
    const fakeTransport = fake(answer);
    return {
      client: new V2HarnessClient({
        baseUrl: 'http://127.0.0.1:4096',
        transport: fakeTransport.transport,
      }),
      calls: fakeTransport.calls,
    };
  }

  const runtimes: [string, () => HarnessClient][] = [
    ['OpenCode 1', v1],
    ['OpenCode 2', v2],
  ];

  it.each(runtimes)('%s creates a session and names it', async (_name, build) => {
    const client = build();

    const id = await client.createSession({ title: 'eval judge', directory: DIRECTORY });

    expect(id).toMatch(/^ses_/);
  });

  it.each(runtimes)(
    '%s answers with the text of the last assistant message',
    async (_name, build) => {
      const client = build();

      const messages = await client.messages({ sessionID: 'ses_case', directory: DIRECTORY });

      expect(replyPartsOf(messages).text).toBe('the answer');
    },
  );

  it.each(runtimes)('%s says which sessions the server is working on', async (_name, build) => {
    const client = build();

    const busy = await client.busySessions({ directory: DIRECTORY });

    expect(busy.has('ses_busy')).toBe(true);
  });

  it.each(runtimes)('%s says the state of the board server', async (_name, build) => {
    const client = build();

    expect(await client.boardStatus({ directory: DIRECTORY })).toEqual({ status: 'connected' });
  });

  it.each(runtimes)('%s lists the sessions of a directory', async (_name, build) => {
    const client = build();

    const sessions = await client.listSessions({ directory: DIRECTORY });

    expect(sessions[0]?.id).toBe('ses_child');
    expect(sessions[0]?.parentID).toBe('ses_case');
  });
});
