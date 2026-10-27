/**
 * A client for the OpenCode 2 API.
 *
 * The 2.x server moved every route under `/api`, renamed the shapes it
 * answers with, and left the directory query behind: a call names its
 * directory with `location[directory]`, and the v1 spelling `directory` is
 * ignored, so a client that sends it lists nothing and says so by
 * answering with an empty list.
 *
 * The client is written on plain `fetch`. The published SDK for the 2.x
 * API does not exist in this workspace, and a suite that waits for one
 * cannot run, so the eleven calls the harness needs are here, over the
 * transport, with the shapes the server really sends.
 */

/** The options a client is built with. */
export type V2ClientOptions = {
  /** The root of the server, for example `http://127.0.0.1:4096`. */
  baseUrl: string;
  /** The password the server was started with. Without one, no header is sent. */
  password?: string;
  /** The directory every call is scoped to. */
  directory: string;
};

/** One request the client makes. */
export type V2Request = {
  method: string;
  headers: Record<string, string>;
  /** The body, when the call has one. */
  body?: string;
  /** The signal that stops the request. */
  signal?: AbortSignal;
};

/** The transport the client sends its requests through. */
export type V2Transport = {
  request: (url: string, init: V2Request) => Promise<Response>;
};

/** What the server says about itself. */
export type V2ServerInfo = {
  version: string;
  pid: number;
  hostname: string;
  urls: string[];
};

/** A session, as the harness reads it. */
export type V2Session = {
  id: string;
  /** The title the session was created with. */
  title?: string;
  /** The directory the session belongs to. */
  directory?: string;
  /** How the last turn ended: `succeeded`, `failed` or `interrupted`. */
  outcome?: string;
  /** The times of the session. */
  time?: { created?: number; updated?: number; idle?: number };
};

/** One part of an assistant message. */
export type V2MessagePart = {
  /** `text` for a text part, `tool` for a tool part. */
  type?: string;
  /** The text of a text part. */
  text?: string;
  /** The name of the tool of a tool part. */
  name?: string;
  /** The state of a tool part. */
  state?: { status?: string; input?: unknown };
};

/** The error a failed turn carries. */
export type V2MessageError = {
  /** The kind of the error, for example `provider.auth`. */
  type?: string;
  /** What the provider said. */
  message?: string;
  /** The status the provider answered with. */
  status?: number;
};

/** A message in a session. */
export type V2Message = {
  id: string;
  /** `user`, `assistant` or `idle`. */
  type?: string;
  /** The text of a user message. A user message is flat; it has no parts. */
  text?: string;
  /** The parts of an assistant message. */
  content?: V2MessagePart[];
  /** The times of the message. An assistant message carries `completed`. */
  time?: { created?: number; completed?: number };
  /** How a turn ended, on the `idle` message. */
  outcome?: string;
  /** The error of a failed turn. */
  error?: V2MessageError;
};

/** The answer to a question: the user message the server accepted. */
export type V2PromptResult = {
  id: string;
  sessionID: string;
  /** The kind of the message. */
  type?: string;
  /** How the message was delivered: `steer` or `queue`. */
  delivery?: string;
  /** The text the server accepted. */
  text?: string;
};

/** The question the harness asks a session. */
export type V2PromptInput = {
  /** The text of the question. */
  text: string;
  /** The agents the question is put to. */
  agents?: { name: string }[];
  /** The model the turn runs on. */
  model?: { id: string; providerID: string; variant?: string };
};

/** How a permission request is answered. */
export type V2PermissionDecision = 'once' | 'always' | 'reject';

/** The answer to a permission request. */
export type V2PermissionReply = {
  /** The decision. The server reads the key `decision`, not `response`. */
  decision: V2PermissionDecision;
  /** What to say with the decision. */
  message?: string;
};

/** A permission request, as the harness reads it. */
export type V2PermissionRequest = {
  /** The id of the request. */
  id: string;
  /** The session that asked. */
  sessionID: string;
  /** What the session wants to do, for example `bash`. */
  action: string;
  /** The resources the request is about. v1 called this `pattern`. */
  resources: string[];
  /** Whether the answer may be remembered. */
  save?: boolean;
  /** What the session says about the request. */
  message?: string;
};

/** The cursor of a page. */
export type V2Cursor = {
  previous: string | null;
  next: string | null;
};

/** A page of sessions. */
export type V2SessionList = {
  sessions: V2Session[];
  cursor?: V2Cursor;
};

/** A page of messages. */
export type V2MessageList = {
  messages: V2Message[];
  cursor?: V2Cursor;
};

/** The sessions the server is working on, keyed by session id. */
export type V2ActiveSessions = Record<string, V2Session>;

/** One MCP server, as the harness reads it. */
export type V2McpServer = {
  /** The name of the server, for example `openagentsy`. */
  name: string;
  /**
   * The state of the server.
   *
   * The state is an object and not a string: `status.status` says whether
   * the server is `connected`, `failed`, `needs_auth` or `disabled`.
   */
  status: { status: string; error?: string };
  /** The title of the server. */
  title?: string;
};

/** The MCP servers of a directory. */
export type V2McpStatus = {
  /** The directory the answer is about. */
  directory: string;
  servers: V2McpServer[];
};

/** One event of the server's stream. */
export type V2Event = {
  id: string;
  /** When the event was made. The server does not send one for every event. */
  created?: number;
  /** What happened, for example `permission.asked`. */
  type: string;
  /** The payload of the event. */
  data?: unknown;
};

/** The event stream of the server. */
export type V2EventStream = AsyncIterable<V2Event> & {
  /** Stop the stream and close the socket. */
  close: () => Promise<void>;
};

/**
 * A body the server answered with that does not have the shape the client
 * needs.
 *
 * A parser that answers `undefined` for a body it cannot read is a parser
 * that fails later, somewhere else, for a reason that has nothing to do
 * with the body. This error names the field that was wrong and keeps the
 * body, so the run says what the server sent.
 */
export class V2ParseError extends Error {
  /** What was wrong with the body. */
  readonly detail: string;
  /** The body the server sent. */
  readonly body: string;

  constructor(detail: string, body: string) {
    super(`the opencode 2 answer did not have the shape the client needs: ${detail}`);
    this.name = 'V2ParseError';
    this.detail = detail;
    this.body = body;
  }
}

/** A non-2xx answer from the server. */
export class V2HttpError extends Error {
  /** The status the server answered with. */
  readonly status: number;
  /** The body the server answered with. */
  readonly body: string;

  constructor(status: number, body: string) {
    super(`the opencode 2 server answered ${status}: ${body}`);
    this.name = 'V2HttpError';
    this.status = status;
    this.body = body;
  }
}

/**
 * The client of the OpenCode 2 API.
 *
 * Every call is scoped to one directory, and the directory is named on the
 * query with `location[directory]`.
 */
export class V2Client {
  /** The root of the server. */
  readonly baseUrl: string;
  /** The directory every call is scoped to. */
  readonly directory: string;
  private readonly password: string | undefined;
  private readonly transport: V2Transport;

  constructor(options: V2ClientOptions, transport: V2Transport = defaultTransport()) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.directory = options.directory;
    this.password = options.password;
    this.transport = transport;
  }

  /** What the server says about itself. */
  async info(): Promise<V2ServerInfo> {
    const body = await this.send('GET', '/info');
    return parseInfo(parseJson(body), body);
  }

  /** Create a session in the directory. */
  async createSession(input: { title?: string } = {}): Promise<V2Session> {
    const body = await this.send('POST', '/session', input);
    return parseSession(envelopeOf(parseJson(body), body).data, body);
  }

  /** Put a question to a session. */
  async prompt(sessionID: string, input: V2PromptInput): Promise<V2PromptResult> {
    const body = await this.send('POST', `/session/${encodeURIComponent(sessionID)}/prompt`, input);
    return parsePromptResult(envelopeOf(parseJson(body), body).data, body);
  }

  /**
   * The messages of a session, oldest first.
   *
   * The server answers with the newest message first and says so in its
   * cursor (`order: desc`). v1 answered the other way round, and the
   * harness read the last message of a list as the reply, so the client
   * sorts them back: the last message is the newest one, as in v1.
   */
  async messages(sessionID: string): Promise<V2MessageList> {
    const body = await this.send('GET', `/session/${encodeURIComponent(sessionID)}/message`);
    const envelope = envelopeOf(parseJson(body), body);
    const items = asArray(envelope.data, 'the message list', body);
    return {
      messages: orderMessages(items.map((item) => parseMessage(item, body))),
      ...(envelope.cursor === undefined ? {} : { cursor: envelope.cursor }),
    };
  }

  /** The sessions the server is working on, keyed by session id. */
  async activeSessions(): Promise<V2ActiveSessions> {
    const body = await this.send('GET', '/session/active');
    const data = asObject(envelopeOf(parseJson(body), body).data, 'the active sessions', body);
    const sessions: V2ActiveSessions = {};
    for (const [id, value] of Object.entries(data)) {
      sessions[id] = parseActiveSession(id, value, body);
    }
    return sessions;
  }

  /** Interrupt the turn a session is running. */
  async interrupt(sessionID: string): Promise<{ interrupted: boolean }> {
    const body = await this.send('POST', `/session/${encodeURIComponent(sessionID)}/interrupt`, {});
    const object = asObject(parseJson(body), 'the interrupt answer', body);
    const interrupted = object['interrupted'];
    if (typeof interrupted !== 'boolean') {
      throw new V2ParseError('`interrupted` was not a boolean', body);
    }
    return { interrupted };
  }

  /** Delete a session. */
  async deleteSession(sessionID: string): Promise<void> {
    await this.send('DELETE', `/session/${encodeURIComponent(sessionID)}`);
  }

  /** The sessions of the directory. */
  async listSessions(): Promise<V2SessionList> {
    const body = await this.send('GET', '/session');
    const envelope = envelopeOf(parseJson(body), body);
    const items = asArray(envelope.data, 'the session list', body);
    return {
      sessions: items.map((item) => parseSession(item, body)),
      ...(envelope.cursor === undefined ? {} : { cursor: envelope.cursor }),
    };
  }

  /**
   * The event stream of the server.
   *
   * The stream is server-sent events, and it stays open until it is
   * closed: a subscription that is dropped leaves the socket open, so the
   * stream is closed with `close`.
   */
  async events(): Promise<V2EventStream> {
    const controller = new AbortController();
    const response = await this.transport.request(this.url('/event'), {
      method: 'GET',
      headers: this.headers('text/event-stream'),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new V2HttpError(response.status, await response.text());
    }
    const body = response.body;
    if (body === null) {
      throw new V2ParseError('the event stream carried no body', '');
    }
    return new SseEventStream(body, controller);
  }

  /** Answer a permission request. */
  async replyPermission(
    sessionID: string,
    requestID: string,
    input: V2PermissionReply,
  ): Promise<void> {
    await this.send(
      'POST',
      `/session/${encodeURIComponent(sessionID)}/permission/${encodeURIComponent(requestID)}/reply`,
      input,
    );
  }

  /** The MCP servers of the directory. */
  async mcpStatus(): Promise<V2McpStatus> {
    const body = await this.send('GET', '/mcp');
    const object = asObject(parseJson(body), 'the mcp answer', body);
    const location = readOptionalObject(object, 'location');
    const items = asArray(object['data'], 'the mcp server list', body);
    return {
      directory: location === undefined ? '' : (readOptionalString(location, 'directory') ?? ''),
      servers: items.map((item) => parseMcpServer(item, body)),
    };
  }

  /** The headers every request carries. */
  private headers(accept = 'application/json'): Record<string, string> {
    const headers: Record<string, string> = { Accept: accept };
    const password = this.password;
    if (password !== undefined && password !== '') {
      const credentials = Buffer.from(`opencode:${password}`).toString('base64');
      headers.Authorization = `Basic ${credentials}`;
    }
    return headers;
  }

  /** The URL of a call, with the location query every call carries. */
  private url(path: string): string {
    const params = new URLSearchParams();
    params.set('location[directory]', this.directory);
    return `${this.baseUrl}/api${path}?${params.toString()}`;
  }

  /** Send one request and answer with the body the server sent. */
  private async send(method: string, path: string, body?: unknown): Promise<string> {
    const headers = this.headers();
    const init: V2Request = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await this.transport.request(this.url(path), init);
    const text = await response.text();
    if (!response.ok) {
      throw new V2HttpError(response.status, text);
    }
    return text;
  }
}

/**
 * The reply of a turn, and the tools it called.
 *
 * Only an assistant message carries parts. A user message is flat: its
 * text is on the message itself.
 */
export function replyOf(messages: readonly V2Message[]): {
  text: string;
  toolCalls: { tool: string; input: unknown }[];
} {
  const spoken = messages.filter(
    (message) => message.type === 'assistant' || message.content !== undefined,
  );
  const parts = spoken.at(-1)?.content ?? [];
  return {
    text: parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('\n'),
    toolCalls: parts
      .filter((part) => part.type === 'tool')
      .map((part) => ({ tool: part.name ?? '', input: part.state?.input })),
  };
}

/**
 * The permission request an event carries, when it is one.
 *
 * v1 sent `permission.updated` and put the request under `properties`. v2
 * sends `permission.asked` and puts it under `data`.
 */
export function permissionRequest(event: V2Event): V2PermissionRequest | undefined {
  if (event.type !== 'permission.asked') return undefined;
  const data = event.data;
  if (!isObject(data)) return undefined;
  const body = JSON.stringify(data);
  const resources = readOptionalArray(data, 'resources') ?? [];
  const request: V2PermissionRequest = {
    id: readString(data, 'id', body),
    sessionID: readString(data, 'sessionID', body),
    action: readString(data, 'action', body),
    resources: resources.filter((item): item is string => typeof item === 'string'),
  };
  const save = readOptionalBoolean(data, 'save');
  if (save !== undefined) request.save = save;
  const message = readOptionalString(data, 'message');
  if (message !== undefined) request.message = message;
  return request;
}

/** The MCP server with a name, when the directory has one. */
export function mcpServer(status: V2McpStatus, name: string): V2McpServer | undefined {
  return status.servers.find((server) => server.name === name);
}

/** The transport the client uses when none is given. */
function defaultTransport(): V2Transport {
  return {
    request: (url, init) =>
      fetch(url, {
        method: init.method,
        headers: init.headers,
        ...(init.body === undefined ? {} : { body: init.body }),
        ...(init.signal === undefined ? {} : { signal: init.signal }),
      }),
  };
}

/** Read a body the server sent as JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new V2ParseError(`the body was not JSON: ${(error as Error).message}`, text);
  }
}

/** The `data` and the `cursor` of an envelope. */
function envelopeOf(value: unknown, body: string): { data: unknown; cursor?: V2Cursor } {
  const object = asObject(value, 'the answer', body);
  if (!('data' in object)) {
    throw new V2ParseError('the answer had no `data`', body);
  }
  const cursor = readOptionalObject(object, 'cursor');
  return {
    data: object['data'],
    ...(cursor === undefined ? {} : { cursor: parseCursor(cursor) }),
  };
}

/** Read the cursor of a page. */
function parseCursor(object: Record<string, unknown>): V2Cursor {
  return {
    previous: readOptionalString(object, 'previous') ?? null,
    next: readOptionalString(object, 'next') ?? null,
  };
}

/** Read what the server says about itself. */
function parseInfo(value: unknown, body: string): V2ServerInfo {
  const object = asObject(value, 'the server info', body);
  return {
    version: readString(object, 'version', body),
    pid: readNumber(object, 'pid', body),
    hostname: readString(object, 'hostname', body),
    urls: asArray(object['urls'], 'the server urls', body).map((url) => {
      if (typeof url !== 'string') {
        throw new V2ParseError('a server url was not a string', body);
      }
      return url;
    }),
  };
}

/** Read a session. */
function parseSession(value: unknown, body: string): V2Session {
  const object = asObject(value, 'a session', body);
  const session: V2Session = { id: readString(object, 'id', body) };
  const title = readOptionalString(object, 'title');
  if (title !== undefined) session.title = title;
  const directory = nestedString(object, 'location', 'directory');
  if (directory !== undefined) session.directory = directory;
  const outcome = readOptionalString(object, 'outcome');
  if (outcome !== undefined) session.outcome = outcome;
  const time = readOptionalObject(object, 'time');
  if (time !== undefined) session.time = parseSessionTime(time);
  return session;
}

/** Read the times of a session. */
function parseSessionTime(object: Record<string, unknown>): {
  created?: number;
  updated?: number;
  idle?: number;
} {
  const time: { created?: number; updated?: number; idle?: number } = {};
  const created = readOptionalNumber(object, 'created');
  if (created !== undefined) time.created = created;
  const updated = readOptionalNumber(object, 'updated');
  if (updated !== undefined) time.updated = updated;
  const idle = readOptionalNumber(object, 'idle');
  if (idle !== undefined) time.idle = idle;
  return time;
}

/**
 * Read one entry of the active session map.
 *
 * The map is keyed by session id, and the harness only asks whether a
 * session is in it, so the entry keeps the fields it came with and takes
 * its id from the key.
 */
function parseActiveSession(id: string, value: unknown, body: string): V2Session {
  if (!isObject(value)) {
    throw new V2ParseError(`the active session ${id} was not an object`, body);
  }
  return parseSession({ ...value, id: value['id'] ?? id }, body);
}

/** Read a message. */
function parseMessage(value: unknown, body: string): V2Message {
  const object = asObject(value, 'a message', body);
  const message: V2Message = { id: readString(object, 'id', body) };
  const type = readOptionalString(object, 'type');
  if (type !== undefined) message.type = type;
  const text = readOptionalString(object, 'text');
  if (text !== undefined) message.text = text;
  const outcome = readOptionalString(object, 'outcome');
  if (outcome !== undefined) message.outcome = outcome;
  const time = readOptionalObject(object, 'time');
  if (time !== undefined) message.time = parseMessageTime(time);
  const content = readOptionalArray(object, 'content');
  if (content !== undefined) message.content = content.map((part) => parsePart(part, body));
  const error = readOptionalObject(object, 'error');
  if (error !== undefined) message.error = parseMessageError(error);
  return message;
}

/** Read the times of a message. */
function parseMessageTime(object: Record<string, unknown>): {
  created?: number;
  completed?: number;
} {
  const time: { created?: number; completed?: number } = {};
  const created = readOptionalNumber(object, 'created');
  if (created !== undefined) time.created = created;
  const completed = readOptionalNumber(object, 'completed');
  if (completed !== undefined) time.completed = completed;
  return time;
}

/** Read the error of a failed turn. */
function parseMessageError(object: Record<string, unknown>): V2MessageError {
  const error: V2MessageError = {};
  const type = readOptionalString(object, 'type');
  if (type !== undefined) error.type = type;
  const message = readOptionalString(object, 'message');
  if (message !== undefined) error.message = message;
  const status = readOptionalNumber(object, 'status');
  if (status !== undefined) error.status = status;
  return error;
}

/** Read one part of an assistant message. */
function parsePart(value: unknown, body: string): V2MessagePart {
  const object = asObject(value, 'a message part', body);
  const part: V2MessagePart = {};
  const type = readOptionalString(object, 'type');
  if (type !== undefined) part.type = type;
  const text = readOptionalString(object, 'text');
  if (text !== undefined) part.text = text;
  const name = readOptionalString(object, 'name');
  if (name !== undefined) part.name = name;
  const state = readOptionalObject(object, 'state');
  if (state !== undefined) part.state = parsePartState(state);
  return part;
}

/** Read the state of a tool part. */
function parsePartState(object: Record<string, unknown>): {
  status?: string;
  input?: unknown;
} {
  const state: { status?: string; input?: unknown } = {};
  const status = readOptionalString(object, 'status');
  if (status !== undefined) state.status = status;
  // The arguments of the call are `null` as often as they are an object,
  // so the key is what counts and not the value.
  if ('input' in object) state.input = object['input'];
  return state;
}

/** Read the answer to a question. */
function parsePromptResult(value: unknown, body: string): V2PromptResult {
  const object = asObject(value, 'the answer to a question', body);
  const result: V2PromptResult = {
    id: readString(object, 'id', body),
    sessionID: readString(object, 'sessionID', body),
  };
  const type = readOptionalString(object, 'type');
  if (type !== undefined) result.type = type;
  const delivery = readOptionalString(object, 'delivery');
  if (delivery !== undefined) result.delivery = delivery;
  const payload = readOptionalObject(object, 'payload');
  const text =
    readOptionalString(object, 'text') ??
    (payload === undefined ? undefined : readOptionalString(payload, 'text'));
  if (text !== undefined) result.text = text;
  return result;
}

/** Read one MCP server. */
function parseMcpServer(value: unknown, body: string): V2McpServer {
  const object = asObject(value, 'an mcp server', body);
  const status = readOptionalObject(object, 'status');
  if (status === undefined) {
    throw new V2ParseError('the mcp server had no `status`', body);
  }
  const server: V2McpServer = {
    name: readString(object, 'name', body),
    status: parseMcpStatus(status, body),
  };
  const title = readOptionalString(object, 'title');
  if (title !== undefined) server.title = title;
  return server;
}

/** Read the state of an MCP server. */
function parseMcpStatus(object: Record<string, unknown>, body: string): V2McpServer['status'] {
  const status: V2McpServer['status'] = { status: readString(object, 'status', body) };
  const error = readOptionalString(object, 'error');
  if (error !== undefined) status.error = error;
  return status;
}

/** Read one event of the stream. */
function parseEvent(payload: string): V2Event {
  const object = asObject(parseJson(payload), 'an event', payload);
  const event: V2Event = {
    id: readString(object, 'id', payload),
    type: readString(object, 'type', payload),
  };
  const created = readOptionalNumber(object, 'created');
  if (created !== undefined) event.created = created;
  if ('data' in object) event.data = object['data'];
  return event;
}

/**
 * Order the messages the way the harness reads them.
 *
 * The server answers with the newest message first. The sort is stable, so
 * two messages made in the same millisecond keep the order the server gave
 * them.
 */
function orderMessages(messages: V2Message[]): V2Message[] {
  return [...messages].sort((left, right) => {
    const first = left.time?.created;
    const second = right.time?.created;
    if (first === undefined || second === undefined) return 0;
    return first - second;
  });
}

/** Is the value an object and not an array? */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read a value that has to be an object. */
function asObject(value: unknown, what: string, body: string): Record<string, unknown> {
  if (!isObject(value)) {
    throw new V2ParseError(`${what} was not an object`, body);
  }
  return value;
}

/** Read a value that has to be an array. */
function asArray(value: unknown, what: string, body: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new V2ParseError(`${what} was not an array`, body);
  }
  return value;
}

/** Read a field that has to be there and has to be a string. */
function readString(object: Record<string, unknown>, key: string, body: string): string {
  const value = object[key];
  if (typeof value !== 'string') {
    throw new V2ParseError(`\`${key}\` was not a string`, body);
  }
  return value;
}

/** Read a field that has to be there and has to be a number. */
function readNumber(object: Record<string, unknown>, key: string, body: string): number {
  const value = object[key];
  if (typeof value !== 'number') {
    throw new V2ParseError(`\`${key}\` was not a number`, body);
  }
  return value;
}

/** Read a field that may be missing. */
function readOptionalString(object: Record<string, unknown>, key: string): string | undefined {
  const value = object[key];
  return typeof value === 'string' ? value : undefined;
}

/** Read a field that may be missing. */
function readOptionalNumber(object: Record<string, unknown>, key: string): number | undefined {
  const value = object[key];
  return typeof value === 'number' ? value : undefined;
}

/** Read a field that may be missing. */
function readOptionalBoolean(object: Record<string, unknown>, key: string): boolean | undefined {
  const value = object[key];
  return typeof value === 'boolean' ? value : undefined;
}

/** Read a field that may be missing. */
function readOptionalObject(
  object: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = object[key];
  return isObject(value) ? value : undefined;
}

/** Read a field that may be missing. */
function readOptionalArray(object: Record<string, unknown>, key: string): unknown[] | undefined {
  const value = object[key];
  return Array.isArray(value) ? value : undefined;
}

/** Read a string field of an object that may be missing. */
function nestedString(
  object: Record<string, unknown>,
  outer: string,
  inner: string,
): string | undefined {
  const nested = readOptionalObject(object, outer);
  if (nested === undefined) return undefined;
  return readOptionalString(nested, inner);
}

/**
 * The event stream of the server, read over `fetch`.
 *
 * The stream is server-sent events: blocks of lines, each block holding
 * one event in its `data` line, and a line that starts with a colon is a
 * comment and carries nothing.
 */
class SseEventStream implements V2EventStream {
  private closed = false;

  constructor(
    private readonly body: ReadableStream<Uint8Array>,
    private readonly controller: AbortController,
  ) {}

  async *[Symbol.asyncIterator](): AsyncGenerator<V2Event, void, undefined> {
    try {
      for await (const block of readSseBlocks(this.body)) {
        const payload = ssePayload(block);
        if (payload === undefined) continue;
        yield parseEvent(payload);
      }
    } catch (error) {
      // A stream that was closed on purpose ends here: the abort was the
      // caller's own doing and not a failure of the server.
      if (this.closed) return;
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
    // A stream that is not read to the end is cancelled, so the socket
    // goes with it.
    await this.body.cancel().catch(() => undefined);
  }
}

/** Read the blocks of an event stream. */
async function* readSseBlocks(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let index = buffer.indexOf('\n\n');
      while (index !== -1) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        yield block;
        index = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
    await body.cancel().catch(() => undefined);
  }
}

/** The payload of one block of an event stream, when it has one. */
function ssePayload(block: string): string | undefined {
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('data:')) {
      data.push(line.slice('data:'.length).replace(/^ /, ''));
    }
  }
  if (data.length === 0) return undefined;
  return data.join('\n');
}
