import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  mcpServer,
  permissionRequest,
  replyOf,
  V2Client,
  type V2Event,
  V2HttpError,
  V2ParseError,
  type V2Transport,
} from './v2client.js';

/**
 * The bodies under `fixtures/v2` were captured from a live OpenCode 2.2.0
 * server on 2026-10-27, so the parsers are measured against what the server
 * really sent and not against what its schema says it sends.
 *
 * Three of them are trimmed, and the trim is deliberate:
 *
 * - `mcp-servers.json` keeps one connected server and one failed server, so
 *   the fixture does not carry the whole tool inventory of the machine that
 *   captured it.
 * - `messages-assistant.json` drops the `response` of the provider error,
 *   which is the provider echoing its own answer back. The shape the
 *   harness reads is the same without it.
 * - `events.sse` keeps the first eight blocks of the capture. They are the
 *   ones that show the two shapes the parser has to survive: an event with
 *   no `created`, and a heartbeat comment that carries no payload.
 */
function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/v2/${name}`, import.meta.url), 'utf8');
}

/** One request the client made. */
type Call = {
  method: string;
  url: string;
  headers: Record<string, string>;
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
      const call: Call = { method: init.method, url, headers: init.headers };
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

/** The one call the client made. */
function onlyCall(calls: Call[]): Call {
  const call = calls[0];
  if (call === undefined) throw new Error('the client made no call');
  return call;
}

/** A client over a fake transport. */
function client(transport: V2Transport, password?: string): V2Client {
  return new V2Client(
    {
      baseUrl: 'http://127.0.0.1:4096',
      directory: '/tmp/case',
      ...(password === undefined ? {} : { password }),
    },
    transport,
  );
}

describe('the calls of the client', () => {
  it('asks the server about itself', async () => {
    const { transport, calls } = fake(() => json(fixture('info.json')));

    const info = await client(transport).info();

    const call = onlyCall(calls);
    expect(call.method).toBe('GET');
    expect(new URL(call.url).pathname).toBe('/api/info');
    expect(new URL(call.url).searchParams.get('location[directory]')).toBe('/tmp/case');
    expect(info.version).toBe('2.2.0');
  });

  it('creates a session', async () => {
    const { transport, calls } = fake(() => json(fixture('session-create.json')));

    const session = await client(transport).createSession({ title: 'probe session' });

    const call = onlyCall(calls);
    expect(call.method).toBe('POST');
    expect(new URL(call.url).pathname).toBe('/api/session');
    // The location is in the body: a session created without it lands in the
    // working directory of the server.
    expect(call.body).toBe('{"title":"probe session","location":{"directory":"/tmp/case"}}');
    expect(session.id).toBe('ses_e81a0ec08ffehgOio28jqJun5M');
  });

  it('asks a session a question', async () => {
    const { transport, calls } = fake(() => json(fixture('prompt-response.json')));

    const result = await client(transport).prompt('ses_abc', { text: 'hello probe' });

    const call = onlyCall(calls);
    expect(call.method).toBe('POST');
    expect(new URL(call.url).pathname).toBe('/api/session/ses_abc/prompt');
    expect(call.body).toBe('{"text":"hello probe"}');
    expect(result.text).toBe('hello probe');
  });

  it('names the agent and the model of a question', async () => {
    const { transport, calls } = fake(() => json(fixture('prompt-response.json')));

    await client(transport).prompt('ses_abc', {
      text: 'hello probe',
      agents: [{ name: 'build' }],
      model: { id: 'minimax-m3.1-flash', providerID: 'ollama-cloud' },
    });

    expect(onlyCall(calls).body).toBe(
      '{"text":"hello probe","agents":[{"name":"build"}],"model":{"id":"minimax-m3.1-flash","providerID":"ollama-cloud"}}',
    );
  });

  it('sets the model of a session', async () => {
    // The prompt body has no model: the model of a turn is the model of its
    // session, and the server answers 204 with an empty body.
    const { transport, calls } = fake(() => new Response(null, { status: 204 }));

    await client(transport).setModel('ses_abc', {
      id: 'minimax-m3.1-flash',
      providerID: 'ollama-cloud',
    });

    const call = onlyCall(calls);
    expect(call.method).toBe('POST');
    expect(new URL(call.url).pathname).toBe('/api/session/ses_abc/model');
    expect(call.body).toBe('{"model":{"id":"minimax-m3.1-flash","providerID":"ollama-cloud"}}');
  });

  it('switches the agent of a session', async () => {
    // The prompt body names the agents a message is put to; the agent of a
    // turn is the agent of its session, and this is the route that changes
    // it.
    const { transport, calls } = fake(() => new Response(null, { status: 204 }));

    await client(transport).attachAgent('ses_abc', 'oa-builder');

    const call = onlyCall(calls);
    expect(call.method).toBe('POST');
    expect(new URL(call.url).pathname).toBe('/api/session/ses_abc/agent');
    expect(call.body).toBe('{"agent":"oa-builder"}');
  });

  it('reads the messages of a session', async () => {
    const { transport, calls } = fake(() => json(fixture('messages.json')));

    const list = await client(transport).messages('ses_abc');

    const call = onlyCall(calls);
    expect(call.method).toBe('GET');
    expect(new URL(call.url).pathname).toBe('/api/session/ses_abc/message');
    expect(list.messages).toHaveLength(1);
  });

  it('reads the parent of a dispatched child', async () => {
    const { transport } = fake(() =>
      json(
        JSON.stringify({
          data: [{ id: 'ses_child', title: 'a child', parentID: 'ses_lead' }],
        }),
      ),
    );

    const list = await client(transport).listSessions();

    expect(list.sessions[0]?.parentID).toBe('ses_lead');
  });

  it('reads the tokens and the cost of a message', async () => {
    const body = JSON.stringify({
      data: [
        {
          id: 'msg_1',
          time: { created: 1, completed: 2 },
          type: 'assistant',
          cost: 0.25,
          tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 3, write: 1 } },
        },
      ],
    });
    const { transport } = fake(() => json(body));

    const list = await client(transport).messages('ses_abc');

    expect(list.messages[0]?.cost).toBe(0.25);
    expect(list.messages[0]?.tokens).toEqual({
      input: 10,
      output: 2,
      reasoning: 0,
      cache: { read: 3, write: 1 },
    });
  });

  it('reads the sessions the server is working on', async () => {
    const { transport, calls } = fake(() => json(fixture('session-active.json')));

    const active = await client(transport).activeSessions();

    const call = onlyCall(calls);
    expect(call.method).toBe('GET');
    expect(new URL(call.url).pathname).toBe('/api/session/active');
    expect(active).toEqual({});
  });

  it('interrupts the turn of a session', async () => {
    const { transport, calls } = fake(() => json(fixture('interrupt.json')));

    const answer = await client(transport).interrupt('ses_abc');

    const call = onlyCall(calls);
    expect(call.method).toBe('POST');
    expect(new URL(call.url).pathname).toBe('/api/session/ses_abc/interrupt');
    expect(answer.interrupted).toBe(false);
  });

  it('deletes a session', async () => {
    const { transport, calls } = fake(() => new Response('', { status: 204 }));

    await client(transport).deleteSession('ses_abc');

    const call = onlyCall(calls);
    expect(call.method).toBe('DELETE');
    expect(new URL(call.url).pathname).toBe('/api/session/ses_abc');
  });

  it('lists the sessions of the directory', async () => {
    const { transport, calls } = fake(() => json(fixture('session-list.json')));

    const list = await client(transport).listSessions();

    const call = onlyCall(calls);
    expect(call.method).toBe('GET');
    expect(new URL(call.url).pathname).toBe('/api/session');
    expect(list.sessions).toHaveLength(2);
  });

  it('answers a permission request', async () => {
    const { transport, calls } = fake(() => new Response('', { status: 204 }));

    await client(transport).replyPermission('ses_abc', 'perm_1', { decision: 'once' });

    const call = onlyCall(calls);
    expect(call.method).toBe('POST');
    expect(new URL(call.url).pathname).toBe('/api/session/ses_abc/permission/perm_1/reply');
    expect(call.body).toBe('{"decision":"once"}');
  });

  it('reads the mcp servers of the directory', async () => {
    const { transport, calls } = fake(() => json(fixture('mcp.json')));

    const status = await client(transport).mcpStatus();

    const call = onlyCall(calls);
    expect(call.method).toBe('GET');
    expect(new URL(call.url).pathname).toBe('/api/mcp');
    expect(status.servers).toEqual([]);
  });

  it('opens the event stream', async () => {
    const { transport, calls } = fake(() => new Response(fixture('events.sse')));

    const stream = await client(transport).events();

    const call = onlyCall(calls);
    expect(call.method).toBe('GET');
    expect(new URL(call.url).pathname).toBe('/api/event');
    expect(new URL(call.url).searchParams.get('location[directory]')).toBe('/tmp/case');
    await stream.close();
  });

  it('sends the location query on every call', async () => {
    const { transport, calls } = fake((call) => {
      const path = new URL(call.url).pathname;
      if (path === '/api/info') return json(fixture('info.json'));
      if (path === '/api/mcp') return json(fixture('mcp.json'));
      if (path === '/api/session/active') return json(fixture('session-active.json'));
      return json(fixture('session-list-empty.json'));
    });
    const subject = client(transport);

    await subject.info();
    await subject.listSessions();
    await subject.mcpStatus();
    await subject.activeSessions();

    for (const call of calls) {
      expect(new URL(call.url).searchParams.get('location[directory]')).toBe('/tmp/case');
    }
  });
});

describe('the credentials of the client', () => {
  it('sends the basic header when the server has a password', async () => {
    const { transport, calls } = fake(() => json(fixture('info.json')));

    await client(transport, 'hunter2').info();

    const expected = Buffer.from('opencode:hunter2').toString('base64');
    expect(onlyCall(calls).headers.Authorization).toBe(`Basic ${expected}`);
  });

  it('sends no header when the server has no password', async () => {
    const { transport, calls } = fake(() => json(fixture('info.json')));

    await client(transport).info();

    expect(onlyCall(calls).headers.Authorization).toBeUndefined();
  });
});

describe('the parsers of the client', () => {
  it('reads the server info', async () => {
    const { transport } = fake(() => json(fixture('info.json')));

    const info = await client(transport).info();

    expect(info.version).toBe('2.2.0');
    expect(info.pid).toBe(19126);
    expect(info.hostname).toBe('selfagency-m1mb.munchkin-mamba.ts.net');
    expect(info.urls).toEqual(['http://127.0.0.1:41999']);
  });

  it('reads a created session', async () => {
    const { transport } = fake(() => json(fixture('session-create.json')));

    const session = await client(transport).createSession({ title: 'probe session' });

    expect(session.id).toBe('ses_e81a0ec08ffehgOio28jqJun5M');
    expect(session.title).toBe('probe session');
    expect(session.directory).toBe('/private/tmp/oa-v2probe');
    expect(session.time?.created).toBe(1793121522681);
  });

  it('reads a session that failed', async () => {
    const { transport } = fake(() => json(fixture('session-get.json')));

    const session = await client(transport).createSession({ title: 'probe session 2' });

    expect(session.outcome).toBe('failed');
    expect(session.id).toBe('ses_e81a0ebf6ffeuFpzQZmRvlcDLv');
    expect(session.time?.idle).toBe(1793121529670);
  });

  it('reads a page of sessions', async () => {
    const { transport } = fake(() => json(fixture('session-list.json')));

    const list = await client(transport).listSessions();

    expect(list.sessions.map((session) => session.id)).toEqual([
      'ses_e81a0ebf6ffeuFpzQZmRvlcDLv',
      'ses_e81a0ec08ffehgOio28jqJun5M',
    ]);
    expect(list.cursor?.next).toContain('eyJhbmNob3Ii');
    expect(list.cursor?.previous).toContain('eyJhbmNob3Ii');
  });

  it('reads an empty page of sessions', async () => {
    const { transport } = fake(() => json(fixture('session-list-empty.json')));

    const list = await client(transport).listSessions();

    expect(list.sessions).toEqual([]);
    expect(list.cursor).toEqual({ previous: null, next: null });
  });

  it('reads the active sessions as a map', async () => {
    const { transport } = fake(() => json('{"data":{"ses_abc":{"id":"ses_abc"}}}'));

    const active = await client(transport).activeSessions();

    expect(Object.keys(active)).toEqual(['ses_abc']);
    expect(active['ses_abc']?.id).toBe('ses_abc');
  });

  it('reads a user message', async () => {
    const { transport } = fake(() => json(fixture('messages.json')));

    const list = await client(transport).messages('ses_abc');

    const message = list.messages[0];
    expect(message?.id).toBe('msg_17e5f292400134OBtAN6ha7cBo');
    expect(message?.type).toBe('user');
    expect(message?.text).toBe('hello probe');
  });

  it('reads the messages oldest first', async () => {
    const { transport } = fake(() => json(fixture('messages-assistant.json')));

    const list = await client(transport).messages('ses_abc');

    // The server sends them newest first, with `order: desc` in its cursor.
    expect(list.messages.map((message) => message.type)).toEqual(['user', 'assistant', 'idle']);
  });

  it('reads an assistant message and the turn that ended it', async () => {
    const { transport } = fake(() => json(fixture('messages-assistant.json')));

    const list = await client(transport).messages('ses_abc');

    const assistant = list.messages[1];
    expect(assistant?.type).toBe('assistant');
    expect(assistant?.content).toEqual([]);
    expect(assistant?.time?.completed).toBe(1793122265932);
    expect(assistant?.error?.status).toBe(403);
    const idle = list.messages[2];
    expect(idle?.type).toBe('idle');
    expect(idle?.outcome).toBe('failed');
  });

  it('reads the answer to a question', async () => {
    const { transport } = fake(() => json(fixture('prompt-response.json')));

    const result = await client(transport).prompt('ses_abc', { text: 'hello probe' });

    expect(result.id).toBe('msg_17e5f292400134OBtAN6ha7cBo');
    expect(result.sessionID).toBe('ses_e81a0ebf6ffeuFpzQZmRvlcDLv');
    expect(result.type).toBe('user');
    expect(result.delivery).toBe('steer');
    expect(result.text).toBe('hello probe');
  });

  it('reads the mcp servers of a directory', async () => {
    const { transport } = fake(() => json(fixture('mcp-servers.json')));

    const status = await client(transport).mcpStatus();

    expect(status.directory).toBe('/tmp/oa-v2mcp');
    expect(status.servers.map((server) => server.name)).toEqual(['probe', '1password']);
    // The state of a server is an object, not a string: `status.status` says
    // whether the server is connected.
    expect(status.servers[0]?.status.status).toBe('failed');
    expect(status.servers[0]?.status.error).toContain('MCP server process exited');
    expect(status.servers[1]?.status.status).toBe('connected');
  });

  it('finds an mcp server by name', async () => {
    const { transport } = fake(() => json(fixture('mcp-servers.json')));

    const status = await client(transport).mcpStatus();

    expect(mcpServer(status, 'probe')?.status.status).toBe('failed');
    expect(mcpServer(status, 'openagentsy')).toBeUndefined();
  });
});

describe('the failures of the client', () => {
  it('throws with the status and the body of a failed answer', async () => {
    const { transport } = fake(() => json(fixture('notfound.txt'), 404));

    const failure = await client(transport)
      .listSessions()
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(V2HttpError);
    const http = failure as V2HttpError;
    expect(http.status).toBe(404);
    expect(http.body).toContain('SessionNotFoundError');
    expect(http.message).toContain('404');
  });

  it('throws when the body is not JSON', async () => {
    const { transport } = fake(() => json('not json at all'));

    const failure = await client(transport)
      .info()
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(V2ParseError);
    expect((failure as V2ParseError).body).toBe('not json at all');
  });

  it('throws when the answer has no data', async () => {
    const { transport } = fake(() => json('{"nope":true}'));

    const failure = await client(transport)
      .listSessions()
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(V2ParseError);
    expect((failure as V2ParseError).message).toContain('data');
  });

  it('throws when a session has no id', async () => {
    const { transport } = fake(() => json('{"data":{"title":"no id"}}'));

    const failure = await client(transport)
      .createSession({ title: 'no id' })
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(V2ParseError);
    expect((failure as V2ParseError).message).toContain('id');
  });

  it('throws when a session is not an object', async () => {
    const { transport } = fake(() => json('{"data":"not a session"}'));

    const failure = await client(transport)
      .createSession({ title: 'x' })
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(V2ParseError);
  });

  it('throws when the interrupt answer has no flag', async () => {
    const { transport } = fake(() => json('{"interrupted":"yes"}'));

    const failure = await client(transport)
      .interrupt('ses_abc')
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(V2ParseError);
  });

  it('throws when an event is not JSON', async () => {
    const { transport } = fake(() => new Response('data: not json\n\n'));

    const stream = await client(transport).events();
    const failure = await (async () => {
      try {
        for await (const _event of stream) {
          // The loop is what reads the event.
        }
        return undefined;
      } catch (error: unknown) {
        return error;
      }
    })();

    expect(failure).toBeInstanceOf(V2ParseError);
    await stream.close();
  });

  it('throws when the event stream answers with a failure', async () => {
    const { transport } = fake(() => json('{"_tag":"UnauthorizedError"}', 401));

    const failure = await client(transport)
      .events()
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(V2HttpError);
    expect((failure as V2HttpError).status).toBe(401);
  });
});

describe('the event stream of the client', () => {
  it('reads the events the server sent', async () => {
    const { transport } = fake(() => new Response(fixture('events.sse')));

    const stream = await client(transport).events();
    const events: V2Event[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    await stream.close();

    expect(events.map((event) => event.type)).toEqual([
      'server.connected',
      'session.inbox.enqueued',
      'session.execution.started',
      'session.instructions.updated',
      'session.inbox.delivered',
      'session.step.started',
      'session.step.failed',
    ]);
  });

  it('reads the payload of an event', async () => {
    const { transport } = fake(() => new Response(fixture('events.sse')));

    const stream = await client(transport).events();
    const events: V2Event[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    await stream.close();

    // The first event has no `created`: the server does not send one for it.
    expect(events[0]?.created).toBeUndefined();
    expect(events[0]?.id).toBe('evt_17e67be91001GWCQiHVm4DT7en');
    const started = events.find((event) => event.type === 'session.step.started');
    const data = started?.data as { sessionID?: string } | undefined;
    expect(data?.sessionID).toBe('ses_e8198418dffet52Esml3z8vYa2');
  });

  it('closes the socket when the stream is closed', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"id":"e1","type":"x"}\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { transport } = fake(() => new Response(body));

    const stream = await client(transport).events();
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    await stream.close();
    await iterator.return?.();

    expect(cancelled).toBe(true);
  });
});

describe('the helpers of the client', () => {
  it('reads the reply and the tool calls of a turn', async () => {
    const { transport } = fake(() =>
      json(
        JSON.stringify({
          data: [
            {
              id: 'msg_1',
              type: 'assistant',
              time: { created: 1, completed: 2 },
              content: [
                { type: 'text', text: 'I looked.' },
                {
                  type: 'tool',
                  name: 'read',
                  state: { status: 'completed', input: { path: 'a' } },
                },
              ],
            },
          ],
        }),
      ),
    );

    const list = await client(transport).messages('ses_abc');
    const reply = replyOf(list.messages);

    expect(reply.text).toBe('I looked.');
    expect(reply.toolCalls).toEqual([{ tool: 'read', input: { path: 'a' } }]);
  });

  it('reads the permission request of an event', () => {
    const event: V2Event = {
      id: 'evt_1',
      type: 'permission.asked',
      data: {
        id: 'perm_1',
        sessionID: 'ses_abc',
        action: 'bash',
        resources: ['ls -la'],
        message: 'run ls -la?',
      },
    };

    const request = permissionRequest(event);

    expect(request?.id).toBe('perm_1');
    expect(request?.sessionID).toBe('ses_abc');
    expect(request?.action).toBe('bash');
    expect(request?.resources).toEqual(['ls -la']);
    expect(request?.message).toBe('run ls -la?');
  });

  it('has no permission request in an event that is not one', () => {
    const event: V2Event = { id: 'evt_1', type: 'session.step.started', data: {} };

    expect(permissionRequest(event)).toBeUndefined();
  });
});
