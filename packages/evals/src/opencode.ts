import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { closeSync, fstatSync, openSync } from 'node:fs';
import { mkdtemp, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { promisify } from 'node:util';
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk';
import { gitFreeEnv } from './git-env.js';
import {
  isSessionNotFound,
  mcpServer,
  V2Client,
  type V2EventStream,
  type V2Message,
  type V2MessagePart,
  type V2Transport,
} from './v2client.js';

/**
 * A model, as the server names it.
 */
export type HarnessModel = {
  /** The provider the model belongs to. */
  providerID: string;
  /** The id of the model. */
  modelID: string;
};

/**
 * A part of a message.
 *
 * A text part carries its text, a tool part carries the name of the tool and
 * the arguments of the call, and a part the server made by itself is marked.
 */
export type HarnessPart = {
  /** What the part is: `text`, `tool` and so on. */
  type: string;
  /** The text of a text part. */
  text?: string;
  /** The name of the tool of a tool part. */
  tool?: string;
  /** The state of a tool part, with the arguments of the call. */
  state?: { input?: unknown };
  /** Whether the server made the part by itself. */
  synthetic?: boolean;
  /** Whether the server ignored the part. */
  ignored?: boolean;
};

/**
 * The times of a message, in the shape the harness reads.
 */
export type HarnessTime = { created?: number; completed?: number };

/**
 * A message of a session, in the shape the harness reads.
 *
 * The harness reads one shape, whatever the runtime sent: an `info` with the
 * role, the times and the error, and a list of parts. OpenCode 1 sends that
 * shape. OpenCode 2 sends a union of tagged messages instead, so the v2
 * client reads the union and answers with this shape, and the readers of the
 * harness are written once and cannot tell the two runtimes apart.
 */
export type HarnessMessage = {
  info: {
    /** The role of the message: `user`, `assistant` and so on. */
    role: string;
    /** The times of the message. */
    time?: HarnessTime;
    /** The error of a failed turn. */
    error?: { message?: string; data?: { statusCode?: number } };
    /** The tokens the turn used, when the server counted them. */
    tokens?: {
      input: number;
      output: number;
      reasoning: number;
      cache: { read: number; write: number };
    };
    /** What the turn cost, in dollars. */
    cost?: number;
  };
  /** The parts of the message. */
  parts: HarnessPart[];
};

/**
 * One event of the server's stream.
 *
 * The shape is the runtime's own: OpenCode 1 sends `{type, properties}` and
 * OpenCode 2 sends the envelope `{id, created, type, data}`. The readers
 * below take both, the way the idle reader does, so the pump is written once.
 */
export type HarnessEvent = {
  /** What happened. */
  type: string;
  /** The payload of an OpenCode 1 event. */
  properties?: unknown;
  /** The payload of an OpenCode 2 event. */
  data?: unknown;
};

/**
 * How a permission request is answered.
 */
export type PermissionDecision = 'once' | 'always' | 'reject';

/**
 * The state of an MCP server, as the harness reads it.
 */
export type HarnessMcpStatus = {
  /** The state of the server: `connected`, `failed`, `pending` and so on. */
  status: string;
  /** What the server said when it failed. */
  error?: string;
};

/**
 * A session of a directory, as the harness reads it.
 */
export type HarnessSession = {
  /** The id of the session. */
  id: string;
  /** The title the session carries. */
  title?: string;
  /** The session that dispatched this one. */
  parentID?: string;
};

/**
 * The question the harness puts to a session.
 */
export type HarnessPrompt = {
  /** The session the question is put to. */
  sessionID: string;
  /** The directory the session lives in. */
  directory: string;
  /** The agent the question is put to. */
  agent: string;
  /** The model the turn runs on. */
  model?: HarnessModel;
  /** The text of the question. */
  text: string;
};

/**
 * The calls the harness makes on the OpenCode server.
 *
 * The harness asks the same questions of both runtimes, and the two servers
 * answer them in different words: OpenCode 1 serves `/session` and OpenCode
 * 2 serves `/api/session`, and the shapes they answer with are not the same.
 * This interface is the boundary. The harness's logic sits on this side of
 * it, and the two implementations sit on the other side, where a call is
 * made and a shape is read.
 */
export type HarnessClient = {
  /** Create a session in a directory. */
  createSession(input: { title: string; directory: string }): Promise<string>;
  /** Put a question to a session. The turn runs in the background. */
  prompt(input: HarnessPrompt): Promise<void>;
  /** The messages of a session, oldest first. */
  messages(input: { sessionID: string; directory: string }): Promise<HarnessMessage[]>;
  /** The sessions the server is working on. */
  busySessions(input: { directory: string }): Promise<ReadonlySet<string>>;
  /** The events of the server, for a directory. */
  events(input: { directory: string }): Promise<AsyncIterable<HarnessEvent>>;
  /** Answer a permission request. */
  replyPermission(input: {
    sessionID: string;
    permissionID: string;
    directory: string;
    decision: PermissionDecision;
  }): Promise<void>;
  /** The state of the board server, when the directory has one. */
  boardStatus(input: { directory: string }): Promise<HarnessMcpStatus | undefined>;
  /** Interrupt the turn a session is running. */
  interrupt(input: { sessionID: string; directory: string }): Promise<void>;
  /** Delete a session. */
  deleteSession(input: { sessionID: string; directory: string }): Promise<void>;
  /** The sessions of a directory. */
  listSessions(input: { directory: string }): Promise<HarnessSession[]>;
};

/**
 * The session a call names is not there.
 *
 * A case can remove a session on purpose, and the server then answers 404 for
 * every call that names it. That is the case's own doing: the turn produced
 * nothing, and the case's own expectations are what judge that. The harness
 * must not report a removed session as a fault of the host.
 *
 * The 1.x server answers a missing session with an empty message list and
 * never raises this; the 2.x server answers 404, and the harness client turns
 * that answer into this error.
 */
export class SessionGoneError extends Error {
  /** The session that is not there. */
  readonly sessionID: string;

  constructor(sessionID: string) {
    super(`the session ${sessionID} is gone`);
    this.name = 'SessionGoneError';
    this.sessionID = sessionID;
  }
}

/** Is this the error of a session that is not there? */
export function isSessionGone(error: unknown): boolean {
  return error instanceof SessionGoneError;
}

const execFileAsync = promisify(execFile);
/**
 * The harness on OpenCode 1.
 *
 * The server speaks the SDK's own API, so the calls are the SDK's calls and
 * the shapes are the SDK's shapes. The work here is the boundary: the
 * message list becomes the shape the harness reads, and the busy map becomes
 * the set of the sessions the server is working on.
 */
export class V1HarnessClient implements HarnessClient {
  constructor(private readonly client: OpencodeClient) {}

  async createSession(input: { title: string; directory: string }): Promise<string> {
    const created = await this.client.session.create({
      body: { title: input.title },
      query: { directory: input.directory },
    });
    if (created.error) {
      throw new Error(`could not create a session: ${JSON.stringify(created.error)}`);
    }
    const id = created.data?.id;
    if (id === undefined) throw new Error('the server created a session without an id');
    return id;
  }

  async prompt(input: HarnessPrompt): Promise<void> {
    const asked = await this.client.session.promptAsync({
      path: { id: input.sessionID },
      body: {
        agent: input.agent,
        ...(input.model !== undefined ? { model: input.model } : {}),
        parts: [{ type: 'text', text: input.text }],
      },
      query: { directory: input.directory },
    });
    if (asked.error) throw new Error(`the prompt failed: ${JSON.stringify(asked.error)}`);
  }

  async messages(input: { sessionID: string; directory: string }): Promise<HarnessMessage[]> {
    const listed = await this.client.session.messages({
      path: { id: input.sessionID },
      query: { directory: input.directory },
    });
    return (listed.data ?? []).map(v1Message);
  }

  async busySessions(input: { directory: string }): Promise<ReadonlySet<string>> {
    const status = await this.client.session.status({ query: { directory: input.directory } });
    const busy = asObject(status.data) ?? {};
    return new Set(Object.keys(busy));
  }

  async events(input: { directory: string }): Promise<AsyncIterable<HarnessEvent>> {
    const subscription = await this.client.event.subscribe({
      query: { directory: input.directory },
    });
    return v1Events(subscription.stream);
  }

  async replyPermission(input: {
    sessionID: string;
    permissionID: string;
    directory: string;
    decision: PermissionDecision;
  }): Promise<void> {
    await this.client.postSessionIdPermissionsPermissionId({
      path: { id: input.sessionID, permissionID: input.permissionID },
      body: { response: input.decision },
      query: { directory: input.directory },
    });
  }

  async boardStatus(input: { directory: string }): Promise<HarnessMcpStatus | undefined> {
    const status = await this.client.mcp.status({ query: { directory: input.directory } });
    const servers = asObject(status.data) ?? {};
    const board = asObject(servers['openagentsy']);
    if (board === undefined) return undefined;
    const state = board['status'];
    return { status: typeof state === 'string' ? state : 'unknown' };
  }

  async interrupt(input: { sessionID: string; directory: string }): Promise<void> {
    await this.client.session.abort({
      path: { id: input.sessionID },
      query: { directory: input.directory },
    });
  }

  async deleteSession(input: { sessionID: string; directory: string }): Promise<void> {
    const deleted = await this.client.session.delete({
      path: { id: input.sessionID },
      query: { directory: input.directory },
    });
    if (deleted.error !== undefined) {
      throw new Error(`the server refused the delete: ${JSON.stringify(deleted.error)}`);
    }
  }

  async listSessions(input: { directory: string }): Promise<HarnessSession[]> {
    const listed = await this.client.session.list({ query: { directory: input.directory } });
    return (listed.data ?? []).map((session) => ({
      id: session.id,
      title: session.title,
      ...(session.parentID === undefined ? {} : { parentID: session.parentID }),
    }));
  }
}

/**
 * The harness on OpenCode 2.
 *
 * The 2.x server moved every route under `/api`, renamed the shapes it
 * answers with, and a client of it is scoped to one directory. The
 * implementation keeps one client per directory the suite asks about, and
 * reads the 2.x shapes into the shape the harness reads.
 */
export class V2HarnessClient implements HarnessClient {
  private readonly clients = new Map<string, V2Client>();

  constructor(
    private readonly options: { baseUrl: string; password?: string; transport?: V2Transport },
  ) {}

  /** The client of a directory, made when the directory is asked about first. */
  private client(directory: string): V2Client {
    const known = this.clients.get(directory);
    if (known !== undefined) return known;
    const options = {
      baseUrl: this.options.baseUrl,
      directory,
      ...(this.options.password !== undefined ? { password: this.options.password } : {}),
    };
    const client =
      this.options.transport === undefined
        ? new V2Client(options)
        : new V2Client(options, this.options.transport);
    this.clients.set(directory, client);
    return client;
  }

  /**
   * Run a call that names a session, and say when the session is gone.
   *
   * The 2.x server answers 404 for a session it does not have. A case can
   * remove its own session on purpose, and that is the case's own doing: the
   * turn produced nothing, and the case's expectations judge that. A 404 on
   * any other path is a fault of the host and is left alone.
   */
  private async session<T>(
    input: { sessionID: string; directory: string },
    call: (client: V2Client) => Promise<T>,
  ): Promise<T> {
    try {
      return await call(this.client(input.directory));
    } catch (error) {
      if (isSessionNotFound(error)) throw new SessionGoneError(input.sessionID);
      throw error;
    }
  }

  async createSession(input: { title: string; directory: string }): Promise<string> {
    const session = await this.client(input.directory).createSession({ title: input.title });
    return session.id;
  }

  async prompt(input: HarnessPrompt): Promise<void> {
    await this.session(input, async (client) => {
      // The agent of a turn is the agent of its session: the prompt body names
      // the agents a message is put to, and the route below is the one that
      // switches the agent of the session. A turn that runs under the default
      // agent is a turn under test that never used the role.
      await client.attachAgent(input.sessionID, input.agent);
      // The model of a turn is the model of its session: the prompt body has no
      // model, and the route that changes it is the one below.
      if (input.model !== undefined) {
        await client.setModel(input.sessionID, {
          id: input.model.modelID,
          providerID: input.model.providerID,
        });
      }
      await client.prompt(input.sessionID, {
        text: input.text,
        agents: [{ name: input.agent }],
      });
    });
  }

  async messages(input: { sessionID: string; directory: string }): Promise<HarnessMessage[]> {
    const list = await this.session(input, (client) => client.messages(input.sessionID));
    return v2Messages(list.messages);
  }

  async busySessions(input: { directory: string }): Promise<ReadonlySet<string>> {
    const active = await this.client(input.directory).activeSessions();
    return new Set(Object.keys(active));
  }

  async events(input: { directory: string }): Promise<AsyncIterable<HarnessEvent>> {
    const stream = await this.client(input.directory).events();
    return v2Events(stream);
  }

  async replyPermission(input: {
    sessionID: string;
    permissionID: string;
    directory: string;
    decision: PermissionDecision;
  }): Promise<void> {
    await this.client(input.directory).replyPermission(input.sessionID, input.permissionID, {
      decision: input.decision,
    });
  }

  async boardStatus(input: { directory: string }): Promise<HarnessMcpStatus | undefined> {
    const status = await this.client(input.directory).mcpStatus();
    const server = mcpServer(status, 'openagentsy');
    if (server === undefined) return undefined;
    return {
      status: server.status.status,
      ...(server.status.error !== undefined ? { error: server.status.error } : {}),
    };
  }

  async interrupt(input: { sessionID: string; directory: string }): Promise<void> {
    await this.client(input.directory).interrupt(input.sessionID);
  }

  async deleteSession(input: { sessionID: string; directory: string }): Promise<void> {
    try {
      // The server answers 204 with an empty body, and the client says so.
      await this.session(input, (client) => client.deleteSession(input.sessionID));
    } catch (error) {
      // The session is gone: that is what the delete wanted, and a kill that
      // found nothing to delete has still killed the session.
      if (!isSessionGone(error)) throw error;
    }
  }

  async listSessions(input: { directory: string }): Promise<HarnessSession[]> {
    const list = await this.client(input.directory).listSessions();
    return list.sessions.map((session) => ({
      id: session.id,
      ...(session.title !== undefined ? { title: session.title } : {}),
      ...(session.parentID !== undefined ? { parentID: session.parentID } : {}),
    }));
  }
}

/**
 * The messages of an OpenCode 2 session, in the shape the harness reads.
 *
 * The 2.x server sends a union of tagged messages. A user message is flat:
 * its text is on the message itself and it has no parts. Only an assistant
 * message carries parts, and the text of a part is on the part while the
 * name of a tool and the arguments of its call are on the part's state.
 *
 * The idle message is the 2.x way of saying that the turn is over, and the
 * harness has no message for it: the error it carries is the error of the
 * turn, so it is folded into the last assistant message and the message
 * itself is dropped. A session that answered then reads exactly like a
 * session of the 1.x server answered.
 */
export function v2Messages(messages: readonly V2Message[]): HarnessMessage[] {
  const mapped: HarnessMessage[] = [];
  for (const message of messages) {
    if (message.type === 'idle') {
      foldIdleError(mapped, message);
      continue;
    }
    mapped.push(v2Message(message));
  }
  return mapped;
}

/** The error of the turn, folded into the last assistant message. */
function foldIdleError(mapped: HarnessMessage[], idle: V2Message): void {
  const error = v2Error(idle);
  if (error === undefined) return;
  const last = mapped.at(-1);
  if (last === undefined || last.info.role !== 'assistant' || last.info.error !== undefined) return;
  last.info.error = error;
}

/** One message of an OpenCode 2 session, in the shape the harness reads. */
function v2Message(message: V2Message): HarnessMessage {
  const type = message.type ?? 'unknown';
  const time = v2Time(message);
  if (type === 'user') return v2UserMessage(message, time);
  if (type === 'assistant') return v2AssistantMessage(message, time);
  if (type === 'synthetic') return v2SyntheticMessage(message, time);
  return { info: { role: type, ...(time === undefined ? {} : { time }) }, parts: [] };
}

/**
 * A user message of an OpenCode 2 session.
 *
 * The message is flat: its text is on the message itself and it has no
 * parts.
 */
function v2UserMessage(message: V2Message, time: HarnessTime | undefined): HarnessMessage {
  return {
    info: { role: 'user', ...(time === undefined ? {} : { time }) },
    parts: [{ type: 'text', text: message.text ?? '' }],
  };
}

/**
 * An assistant message of an OpenCode 2 session.
 *
 * The parts carry the answer: the text of a part is on the part, and the
 * name of a tool and the arguments of its call are on the part's state.
 */
function v2AssistantMessage(message: V2Message, time: HarnessTime | undefined): HarnessMessage {
  const error = v2Error(message);
  const tokens = harnessTokens(message.tokens);
  const cost = message.cost;
  return {
    info: {
      role: 'assistant',
      ...(time === undefined ? {} : { time }),
      ...(error === undefined ? {} : { error }),
      ...(tokens === undefined ? {} : { tokens }),
      ...(cost !== undefined ? { cost } : {}),
    },
    parts: (message.content ?? []).map(v2Part),
  };
}

/**
 * A synthetic message of an OpenCode 2 session.
 *
 * The model switch is a message of its own and it carries no reply, so the
 * part is marked and the reader of the reply passes over it.
 */
function v2SyntheticMessage(message: V2Message, time: HarnessTime | undefined): HarnessMessage {
  return {
    info: { role: 'assistant', ...(time === undefined ? {} : { time }) },
    parts: [{ type: 'text', text: message.text ?? '', synthetic: true, ignored: true }],
  };
}

/** The times of a message of an OpenCode 2 session. */
function v2Time(message: V2Message): HarnessTime | undefined {
  const time = message.time;
  if (time === undefined) return undefined;
  const created = time.created;
  const completed = time.completed;
  return {
    ...(created !== undefined ? { created } : {}),
    ...(completed !== undefined ? { completed } : {}),
  };
}

/** The error of a failed turn of an OpenCode 2 session. */
function v2Error(
  message: V2Message,
): { message?: string; data?: { statusCode?: number } } | undefined {
  const error = message.error;
  if (error === undefined) return undefined;
  const text = error.message;
  const status = error.status;
  return {
    ...(text !== undefined ? { message: text } : {}),
    ...(status !== undefined ? { data: { statusCode: status } } : {}),
  };
}

/** One part of an assistant message of an OpenCode 2 session. */
function v2Part(part: V2MessagePart): HarnessPart {
  const text = part.text;
  const name = part.name;
  const state = part.state;
  const input = state?.input;
  return {
    type: part.type ?? 'unknown',
    ...(text !== undefined ? { text } : {}),
    ...(name !== undefined ? { tool: name } : {}),
    ...(state === undefined ? {} : { state: { ...(input !== undefined ? { input } : {}) } }),
  };
}

/** A message of an OpenCode 1 session, in the shape the harness reads. */
function v1Message(message: unknown): HarnessMessage {
  const shape = asObject(message) ?? {};
  const info = asObject(shape['info']) ?? {};
  const time = v1Time(asObject(info['time']));
  const error = v1Error(asObject(info['error']));
  const tokens = harnessTokens(info['tokens']);
  const cost = info['cost'];
  const parts = Array.isArray(shape['parts']) ? shape['parts'] : [];
  return {
    info: {
      role: typeof info['role'] === 'string' ? info['role'] : 'assistant',
      ...(time === undefined ? {} : { time }),
      ...(error === undefined ? {} : { error }),
      ...(tokens === undefined ? {} : { tokens }),
      ...(typeof cost === 'number' ? { cost } : {}),
    },
    parts: parts.map(v1Part),
  };
}

/** The tokens a turn used, when the server counted them. */
function harnessTokens(value: unknown): HarnessMessage['info']['tokens'] | undefined {
  const shape = asObject(value);
  if (shape === undefined) return undefined;
  const cache = asObject(shape['cache']) ?? {};
  return {
    input: numberOf(shape['input']),
    output: numberOf(shape['output']),
    reasoning: numberOf(shape['reasoning']),
    cache: { read: numberOf(cache['read']), write: numberOf(cache['write']) },
  };
}

/** The number under a key, or zero. */
function numberOf(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

/** The times of a message of an OpenCode 1 session. */
function v1Time(
  time: Record<string, unknown> | undefined,
): { created?: number; completed?: number } | undefined {
  if (time === undefined) return undefined;
  const created = time['created'];
  const completed = time['completed'];
  return {
    ...(typeof created === 'number' ? { created } : {}),
    ...(typeof completed === 'number' ? { completed } : {}),
  };
}

/** The error of a failed turn of an OpenCode 1 session. */
function v1Error(
  error: Record<string, unknown> | undefined,
): { message?: string; data?: { statusCode?: number } } | undefined {
  if (error === undefined) return undefined;
  const message = error['message'];
  const data = asObject(error['data']);
  const statusCode = data?.['statusCode'];
  return {
    ...(typeof message === 'string' ? { message } : {}),
    ...(data === undefined
      ? {}
      : { data: { ...(typeof statusCode === 'number' ? { statusCode } : {}) } }),
  };
}

/** One part of a message of an OpenCode 1 session. */
function v1Part(part: unknown): HarnessPart {
  const shape = asObject(part) ?? {};
  const state = asObject(shape['state']);
  const input = state?.['input'];
  const text = shape['text'];
  const tool = shape['tool'];
  const synthetic = shape['synthetic'];
  const ignored = shape['ignored'];
  return {
    type: typeof shape['type'] === 'string' ? shape['type'] : 'unknown',
    ...(typeof text === 'string' ? { text } : {}),
    ...(typeof tool === 'string' ? { tool } : {}),
    ...(state === undefined ? {} : { state: { ...(input !== undefined ? { input } : {}) } }),
    ...(synthetic === true ? { synthetic: true } : {}),
    ...(ignored === true ? { ignored: true } : {}),
  };
}

/** The events of an OpenCode 1 server, in the shape the pump reads. */
async function* v1Events(stream: AsyncIterable<unknown>): AsyncGenerator<HarnessEvent> {
  for await (const event of stream) {
    const shape = asObject(event) ?? {};
    const type = shape['type'];
    const properties = shape['properties'];
    yield {
      type: typeof type === 'string' ? type : 'unknown',
      ...(properties !== undefined ? { properties } : {}),
    };
  }
}

/** The events of an OpenCode 2 server, in the shape the pump reads. */
async function* v2Events(stream: V2EventStream): AsyncGenerator<HarnessEvent> {
  try {
    for await (const event of stream) {
      yield { type: event.type, ...(event.data !== undefined ? { data: event.data } : {}) };
    }
  } finally {
    // The socket of the stream stays open until it is closed, and a case that
    // is over leaves it behind.
    await stream.close();
  }
}

export type SessionTurn = {
  /** The text the agent under test produced. */
  text: string;
  /** Every tool the agent called, with its arguments. */
  toolCalls: { tool: string; input: unknown }[];
  /** The files the agent wrote, as absolute paths. */
  files: string[];
  /** The session the turn ran in, for the token count. */
  sessionID: string;
};

export type OpenCodeHarness = {
  client: HarnessClient;
  root: string;
  /**
   * The runtime the harness started.
   *
   * A verdict says which runtime measured it: the runtimes differ in more
   * than their API, and a run that cannot name its runtime is a run whose
   * result cannot be read.
   */
  runtime: OpenCodeRuntime;
  stop: () => Promise<void>;
  /**
   * The faults that are still watching.
   *
   * A watcher outlives the turn that started it, so the harness keeps it
   * here and waits for it when the case ends. A watcher that is dropped
   * keeps polling after the case is gone.
   */
  watches: { killed: Promise<string | undefined>; stop: () => void }[];
  /**
   * The host errors the server wrote since it started, each with the case it
   * belongs to. `stop` reads the same list and throws when it holds a fault.
   *
   * The sessions the harness killed are excluded: their abort is the fault
   * the case injected, not a host failure. The errors the policy exempts are
   * reported next to the faults, so the run says what it ignored.
   */
  hostErrors: (killedSessions?: ReadonlySet<string>) => Promise<HostErrorReport>;
  /**
   * Say which case a session belongs to, so a host error that names it is
   * attributed instead of falling back to the suite as a whole.
   */
  trackSession: (sessionID: string, caseLabel: string) => void;
  /**
   * Say that a case injected a fault into a session.
   *
   * The provider faults (a 429 and a provider that is down) are injected into
   * the turn the harness runs, and the server writes the fault as an ERROR
   * naming the session. That error is the case proving the fault landed, not
   * the host failing, so the harness excludes it the way it excludes the
   * errors of a session it killed.
   */
  markFaultedSession: (sessionID: string) => void;
  /**
   * The idle events the event stream carried.
   *
   * The subscription of a case is scoped to its directory and sees the
   * idle event of every session in it, so the registry is how the wait for
   * a turn learns that the turn is over.
   */
  idle: IdleRegistry;
};

/**
 * The OpenCode the harness started.
 *
 * The binary is named by the environment, because a machine may have more
 * than one: the suite talks to the OpenCode 1 API, and a machine whose
 * `opencode` is a 2.x serves the 2.x API instead. The default is the one on
 * the path.
 */
export type OpenCodeRuntime = {
  /** The binary the harness runs. */
  binary: string;
  /** The version the binary reported, for example "1.19.4". */
  version: string;
  /** The major version: 1 or 2. */
  major: number;
};

/**
 * The binary the harness starts.
 *
 * The suite drives the OpenCode 1 API, so the binary is the one that serves
 * it. The environment names it, because the machine's `opencode` may be a
 * different major version, and the path is not a thing the code may decide.
 */
export function runtimeBinary(): string {
  const named = process.env.OPENAGENTSY_EVAL_BIN?.trim();
  return named !== undefined && named !== '' ? named : 'opencode';
}

/**
 * Read the version of the runtime the harness will start.
 *
 * A version that cannot be read is a run whose result cannot be read, so the
 * harness stops rather than measuring with a runtime it cannot name.
 */
export async function readRuntime(binary: string): Promise<OpenCodeRuntime> {
  let output: string;
  try {
    const result = await execFileAsync(binary, ['--version']);
    output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  } catch (error) {
    throw new Error(
      `the opencode runtime ${binary} could not be started: ${(error as Error).message}`,
    );
  }
  const found = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  if (found === null) {
    throw new Error(`the opencode runtime ${binary} did not report a version: ${output.trim()}`);
  }
  return { binary, version: found[0], major: Number(found[1]) };
}

/**
 * A permission request, as the harness reads it.
 */
export type PermissionRequest = {
  /** The session that asked. */
  sessionID: string;
  /** The id of the request. */
  permissionID: string;
  /** What the session says about the request. */
  title: string;
  /** What the session wants to do, for example `edit`. */
  type: string;
  /** The paths the request is about. */
  patterns: string[];
};

/**
 * How a permission request is answered.
 *
 * The Lead asks before it runs a shell command, and in a headless session
 * nobody is there to answer, so the tool call waits forever. The harness
 * answers, the way the user in the case would.
 */
export type PermissionPolicy = (request: PermissionRequest) => PermissionDecision;

const DEFAULT_PERMISSION: PermissionPolicy = () => 'once';

/**
 * The patterns a permission request names.
 *
 * The server sends the pattern under the key `pattern`, as a string or as a
 * list of them. A reader that looks for `patterns` sees an empty list for
 * every request, and a policy that refuses a path by its patterns can then
 * never refuse one.
 */
export function permissionPatterns(properties: {
  pattern?: string | string[] | undefined;
  patterns?: string[] | undefined;
  resources?: string[] | undefined;
}): string[] {
  if (Array.isArray(properties.pattern)) return properties.pattern;
  if (typeof properties.pattern === 'string') return [properties.pattern];
  if (Array.isArray(properties.patterns)) return properties.patterns;
  if (Array.isArray(properties.resources)) return properties.resources;
  return [];
}

/**
 * The events that carry a permission request.
 *
 * OpenCode 1 sent `permission.updated` and OpenCode 2 sends
 * `permission.asked`. Every other event of the stream is not a request, and
 * some of them carry an id and a session id of their own: the id of a tool
 * call, for one, and the server refuses that as the id of a permission.
 */
const PERMISSION_EVENTS = new Set(['permission.updated', 'permission.asked']);

/**
 * The permission request an event carries, when it is one.
 *
 * OpenCode 1 sent `permission.updated` and put the request under
 * `properties`, with the paths it is about under `pattern`. OpenCode 2 sends
 * `permission.asked` and puts the request under `data`, with the same paths
 * under `resources`. Both are read here, so the pump answers a request the
 * same way on both runtimes.
 */
export function permissionRequestOf(event: HarnessEvent): PermissionRequest | undefined {
  if (!PERMISSION_EVENTS.has(event.type)) return undefined;
  const payload = asObject(event.properties) ?? asObject(event.data);
  if (payload === undefined) return undefined;
  const id = payload['id'];
  const sessionID = payload['sessionID'];
  if (typeof id !== 'string' || typeof sessionID !== 'string') return undefined;
  const pattern = payload['pattern'];
  const patternValue = typeof pattern === 'string' ? pattern : stringList(pattern);
  const patterns = stringList(payload['patterns']);
  const resources = stringList(payload['resources']);
  return {
    sessionID,
    permissionID: id,
    title: stringOf(payload, 'title') ?? stringOf(payload, 'message') ?? '',
    type: stringOf(payload, 'type') ?? stringOf(payload, 'action') ?? '',
    patterns: permissionPatterns({
      ...(patternValue !== undefined ? { pattern: patternValue } : {}),
      ...(patterns !== undefined ? { patterns } : {}),
      ...(resources !== undefined ? { resources } : {}),
    }),
  };
}

/**
 * The idle events the event stream carried, per session.
 *
 * The server says a session is idle when its turn is over, and the
 * harness's own subscription sees the event: the turn of a session is over
 * when the server says the session is idle. The registry counts the idle
 * events of every session and remembers where the turn of a session began,
 * so an idle that came before the prompt cannot end the turn.
 */
export class IdleRegistry {
  private readonly idle = new Map<string, number>();
  private readonly marks = new Map<string, number>();

  /** Record that the server said the session is idle. */
  record(sessionID: string): void {
    this.idle.set(sessionID, (this.idle.get(sessionID) ?? 0) + 1);
  }

  /** Note that the turn of a session begins now. */
  beginTurn(sessionID: string): void {
    this.marks.set(sessionID, this.idle.get(sessionID) ?? 0);
  }

  /** The idle events the session had since its turn began. */
  sinceTurnStart(sessionID: string): number {
    return (this.idle.get(sessionID) ?? 0) - (this.marks.get(sessionID) ?? 0);
  }
}

/**
 * The session an event says is idle.
 *
 * The v1 server sends `{type, properties}` and the v2 server sends the
 * envelope `{id, created, type, location?, data}`. The harness's own
 * subscription receives the v1 shape today, and the v2 client hands over
 * the other one, so both are read here and the next wiring does not have
 * to change this.
 *
 * Two events say that a session is idle: `session.idle`, and a
 * `session.status` whose status is `idle`. The v2 schema calls the first
 * one deprecated, so the second one is what a v2 server sends.
 */
export function idleSessionOf(event: unknown): string | undefined {
  const shape = asObject(event);
  if (shape === undefined) return undefined;
  const type = shape['type'];
  if (typeof type !== 'string') return undefined;
  const body = asObject(shape['properties']) ?? asObject(shape['data']);
  const sessionID = body?.['sessionID'];
  if (typeof sessionID !== 'string') return undefined;
  if (type === 'session.idle') return sessionID;
  if (type !== 'session.status') return undefined;
  return asObject(body?.['status'])?.['type'] === 'idle' ? sessionID : undefined;
}

/** Is the value an object and not an array? */
function asObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** The string under a key, when the value is a string. */
function stringOf(object: Record<string, unknown>, key: string): string | undefined {
  const value = object[key];
  return typeof value === 'string' ? value : undefined;
}

/** The strings of a list, when the value is a list. */
function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

/**
 * Watch the server for permission requests and answer them.
 *
 * The event stream is scoped to a directory, so one subscription serves one
 * case. Without an answer the first shell command of a case waits forever,
 * which looks like a slow model and is not.
 *
 * The subscription stays scoped to the case. A subscription for the whole
 * server would have every case answer every case's requests, and a case
 * whose policy refuses the protected paths would refuse another case's
 * edit. A request from a session outside the case's directory is the case
 * that owns it that answers, and the lines below say which case answered
 * which request.
 */
export async function answerPermissions(
  harness: OpenCodeHarness,
  directory: string,
  policy: PermissionPolicy = DEFAULT_PERMISSION,
): Promise<() => void> {
  const stream = await harness.client.events({ directory });
  let stopped = false;

  const pump = async (): Promise<void> => {
    for await (const event of stream) {
      if (stopped) return;
      if (process.env.OPENAGENTSY_EVAL_TRACE) {
        const { appendFileSync } = await import('node:fs');
        appendFileSync(
          process.env.OPENAGENTSY_EVAL_TRACE,
          `${new Date().toISOString()} ${event.type}\n`,
        );
      }
      // The idle event is the end of a turn, so it is kept: the wait for a
      // turn reads it, and a run that hung says nothing without it.
      const idleSession = idleSessionOf(event);
      if (idleSession !== undefined) harness.idle.record(idleSession);
      const request = permissionRequestOf(event);
      if (request === undefined) continue;
      // Every request is written down before it is answered. A case that
      // waits for a permission answer and a case that waits for a child
      // session that never returns look the same in a run log, and only the
      // request line tells the two apart.
      process.stdout.write(
        `[permission] ${request.sessionID} asks for ${request.type} in ${directory}: ${request.patterns.join(' ')}\n`,
      );
      const response = policy(request);
      // The subscription is scoped to the case directory, so a session that
      // asks here belongs to this case; a host error naming it is attributed.
      harness.trackSession(request.sessionID, basename(directory));
      await harness.client.replyPermission({
        sessionID: request.sessionID,
        permissionID: request.permissionID,
        directory,
        decision: response,
      });
      process.stdout.write(`[permission] ${request.sessionID} answered ${response}\n`);
    }
    if (!stopped) {
      // The stream ended without the harness asking for it: the server
      // closed the subscription. Every permission request from now on waits
      // for an answer that will not come, and a case that waits looks like
      // a slow model.
      process.stderr.write(
        `[permission] the pump for ${directory} ended: the server closed the event stream, and every permission request from now on waits for an answer that will not come\n`,
      );
    }
  };

  void pump().catch((error: unknown) => {
    // The pump answers the permissions of a case. A throw ends the
    // answering for the rest of the case, and nothing else in the run says
    // so, so the death is written down loudly.
    process.stderr.write(`[permission] the pump for ${directory} died: ${String(error)}\n`);
  });

  return () => {
    stopped = true;
  };
}

/**
 * The errors the host wrote, and the policy for them.
 *
 * Policy: every ERROR or FATAL line the server writes is a fault of the run,
 * not of the case. A host fault that lands while a case runs can make that
 * case pass for the wrong reason, so it is never discarded because the case
 * went green. The harness keeps every one from the byte offset the server
 * started at, attributes it to the case that owns the session it names, and
 * falls back to `the suite` when the line names a session it never tracked
 * (a plugin-created child session, for example): an unplaceable fault is
 * still a fault and is never dropped. `stop` throws when there is any, which
 * fails the suite at teardown: a green case result cannot hide a host fault.
 *
 * The structured `timestamp=… level=…` lines only reach the file `stop`
 * reads because `serve` is started with `--print-logs`, which sends them to
 * stderr and stderr is redirected to that file. Without the flag the server
 * writes them to the app log under `~/.local/share/opencode/log/`, the file
 * stays empty of structured lines, and this check would silently see nothing.
 *
 * An ERROR line is the server's own report of something that went wrong; a
 * multi-line error keeps its continuation lines, or the stack that says why
 * is lost. Lines at INFO or below are the server working normally.
 */
export type HostError = {
  /** The case the error belongs to, or `the suite` when no session named one. */
  case: string;
  /** The log block, continuation lines included. */
  line: string;
  /** The session the log line named, when it named one. */
  sessionID?: string;
};

/** One error block, before it is attributed to a case. */
export type HostErrorBlock = { line: string; sessionID?: string };

/**
 * The errors a run keeps, and the ones the policy exempts.
 *
 * The exempted ones are kept as well: a run that hides them is a run that
 * lies about what happened, so they are counted and reported.
 */
export type HostErrorReport = {
  /** The errors that fail the run. */
  faults: HostError[];
  /** The errors the policy exempts. */
  exempted: HostError[];
  /** The errors of the sessions the case injected a fault into. */
  injected: HostError[];
};

/** The error blocks that are faults, and the ones the policy exempts. */
export type HostErrorBlocks = {
  faults: HostErrorBlock[];
  exempted: HostErrorBlock[];
  injected: HostErrorBlock[];
};

/** A line the server wrote, with its level. Continuation lines have none. */
const LOG_HEADER = /^timestamp=\S+ level=(\S+) /;

/** The host errors in a block of log text, before attribution to a case. */
export function hostErrorsIn(text: string): HostErrorBlock[] {
  const blocks: HostErrorBlock[] = [];
  let block: string[] | undefined;
  let level: string | undefined;

  const flush = (): void => {
    if (block === undefined) return;
    if (level === 'ERROR' || level === 'FATAL') {
      const line = block.join('\n').trim();
      // The server has written both shapes: `session.id=` and the plain
      // `sessionID=` the measured query error carried. Either one names the
      // session; matching only one lost the attribution.
      const session = /session(?:\.id|ID)=(\S+)/.exec(line);
      blocks.push(session?.[1] !== undefined ? { line, sessionID: session[1] } : { line });
    }
    block = undefined;
    level = undefined;
  };

  for (const line of text.split('\n')) {
    const header = LOG_HEADER.exec(line);
    if (header !== null) {
      flush();
      block = [line];
      level = header[1];
    } else if (block !== undefined) {
      block.push(line);
    }
  }
  flush();
  return blocks;
}

/** Put each host error on the case whose session it names, or on the suite. */
export function attributeHostErrors(
  blocks: readonly HostErrorBlock[],
  sessions: ReadonlyMap<string, string>,
): HostError[] {
  return blocks.map((block) => {
    const owner = block.sessionID !== undefined ? sessions.get(block.sessionID) : undefined;
    return {
      case: owner ?? 'the suite',
      line: block.line,
      ...(block.sessionID !== undefined ? { sessionID: block.sessionID } : {}),
    };
  });
}

/**
 * The host errors that are faults of the run, and the ones the policy exempts.
 *
 * One error is expected: the case that kills a builder on purpose
 * (`fault builder killed`) aborts the builder's session mid-turn, and the
 * server writes `level=ERROR ... error=Aborted` against that session. That
 * line is the case proving the fault landed, not the host failing, so it must
 * not fail the suite. Every other ERROR or FATAL block is still a fault: the
 * case did not ask the server to abort it. A block that names no session
 * cannot be tied to a kill and is kept.
 *
 * The killed sessions are the ones the watches resolved to: a watch that gave
 * up resolves undefined and contributes nothing.
 *
 * One more class is exempt, and only one: a file watcher that could not
 * attach (see `isWatcherFailure`). It is reported, but it does not fail the
 * run.
 *
 * A third class is the case's own doing as well: the case that injects a
 * fault into its own turn (a provider that answers 429, a provider that is
 * down) sees the server write that fault as an ERROR naming the session. The
 * harness knows the sessions it faulted, and the errors of those sessions are
 * counted and reported, not failed.
 */
export function splitHostErrors(
  blocks: readonly HostErrorBlock[],
  killedSessions: ReadonlySet<string>,
  faultedSessions: ReadonlySet<string> = new Set(),
): HostErrorBlocks {
  const faults: HostErrorBlock[] = [];
  const exempted: HostErrorBlock[] = [];
  const injected: HostErrorBlock[] = [];
  for (const block of blocks) {
    if (block.sessionID !== undefined && killedSessions.has(block.sessionID)) continue;
    if (block.sessionID !== undefined && faultedSessions.has(block.sessionID)) {
      injected.push(block);
      continue;
    }
    if (isWatcherFailure(block)) {
      exempted.push(block);
      continue;
    }
    faults.push(block);
  }
  return { faults, exempted, injected };
}

/** The host errors that are faults of the run. */
export function hostFaults(
  blocks: readonly HostErrorBlock[],
  killedSessions: ReadonlySet<string>,
): HostErrorBlock[] {
  return splitHostErrors(blocks, killedSessions).faults;
}

/**
 * The message the server writes when a file watcher cannot attach.
 *
 * Measured on 2026-10-27 on macOS: the server opens a watcher on the
 * directory a case serves, and FSEvents refuses to open a stream for a path
 * under the OS temp dir, so the server writes this error.
 */
const WATCHER_FAILURE = 'failed to subscribe';

/**
 * The `key=value` fields of a structured log line.
 *
 * The server writes the fields in order, and a value with a space in it is
 * quoted. A `key=value` inside a quoted value belongs to that value, so the
 * line is walked and not searched.
 */
export function logFields(line: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const match of line.matchAll(/([\w.]+)=("(?:[^"\\]|\\.)*"|[^\s]*)/g)) {
    const key = match[1];
    const raw = match[2];
    if (key === undefined || raw === undefined) continue;
    fields.set(key, raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(["\\])/g, '$1') : raw);
  }
  return fields;
}

/**
 * Is this error a file watcher that could not attach?
 *
 * The measured line (2026-10-27, macOS) is:
 *
 *   level=ERROR … message="failed to subscribe" directory=/…/openagentsy-eval-seeded-bug-cwZs34/.git cause="Error: Error starting FSEvents stream …"
 *
 * The policy of the suite is that a case which passed while the host failed
 * did not measure the agent. The failures that make a passing case
 * meaningless are a model that refused, a tool that broke and a server that
 * died. A watcher that could not subscribe is none of those: no tool call
 * depends on it, and the state of the case on disk, on the board and in the
 * audit log is complete. So a watcher that cannot attach is never a host
 * fault, on any path.
 *
 * The path does not decide, and it is not the path the error names that
 * matters. The OpenCode 1 server watched the directory of the case, and the
 * OpenCode 2 server watches the machine's global skill directories as well;
 * the watcher cannot attach to those either, and the same noise came back
 * through a different path.
 *
 * The error has to name the directory it could not watch: a failure to
 * subscribe that names no directory is not a file watcher, and the harness
 * reads the event stream, so a stream that cannot be subscribed to is a fault
 * of the host.
 */
export function isWatcherFailure(block: HostErrorBlock): boolean {
  const fields = logFields(block.line.split('\n', 1)[0] ?? '');
  if (fields.get('message') !== WATCHER_FAILURE) return false;
  const directory = fields.get('directory');
  return directory !== undefined && directory !== '';
}

/** Is the path the directory itself, or a path under it? */
function isWithin(dir: string, path: string): boolean {
  if (path === dir) return true;
  return path.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);
}

/**
 * Is this watcher failure on a throwaway directory of this run?
 *
 * The report tells the reader where the failure was, and a directory that
 * only looks like a case directory is not one.
 */
function onCaseDir(error: HostError, caseDirs: ReadonlySet<string>): boolean {
  const directory = logFields(error.line.split('\n', 1)[0] ?? '').get('directory');
  if (directory === undefined || directory === '') return false;
  return [...caseDirs].some((dir) => isWithin(dir, directory));
}

/**
 * The line the run reports the exempted errors with.
 *
 * The count and the first error are both in it: a run that hides the errors
 * it ignored is a run that lies about what happened. The path is in it too,
 * because the reader has to see whether the watcher failed on a directory of
 * this run or on a path of the machine, and the two say different things.
 */
export function watcherExemptionLine(
  exempted: readonly HostError[],
  caseDirs: ReadonlySet<string> = caseDirsOfRun(),
): string {
  const first = exempted[0];
  const detail = first === undefined ? '' : `\n  ${first.line.replace(/\n/g, '\n  ')}`;
  const onCase = exempted.filter((error) => onCaseDir(error, caseDirs)).length;
  return `the opencode server wrote ${exempted.length} watcher error(s)${watcherErrorsWhere(onCase, exempted.length)}; a watcher that cannot attach is not a host fault:${detail}`;
}

/** Where the exempted watcher failures were. */
function watcherErrorsWhere(onCase: number, total: number): string {
  if (onCase === total) return ' on a throwaway directory of this run';
  if (onCase === 0) return ' on another path';
  return `: ${onCase} on a throwaway directory of this run, ${total - onCase} on another path`;
}

/**
 * The line the run reports the errors of a faulted session with.
 *
 * The count and the first error are both in it: a run that hides the errors
 * it ignored is a run that lies about what happened.
 */
export function injectedFaultLine(injected: readonly HostError[]): string {
  const first = injected[0];
  const detail = first === undefined ? '' : `\n  ${first.line.replace(/\n/g, '\n  ')}`;
  return `the opencode server wrote ${injected.length} error(s) about a session the case injected a fault into; the fault is the case's own doing:${detail}`;
}

/**
 * Read the host errors appended to a log file after a byte offset.
 *
 * The offset is what makes this testable without a server: the caller passes
 * the size the file had when the run started, and only what was appended
 * afterwards is read. A block naming a session the harness killed is the
 * injected fault, not a host error, so it is dropped here.
 *
 * The errors the policy exempts are returned next to the faults, because a
 * run that does not say what it ignored cannot be read.
 */
export async function readHostErrors(
  logFile: string,
  fromOffset = 0,
  sessions: ReadonlyMap<string, string> = new Map(),
  killedSessions: ReadonlySet<string> = new Set(),
  faultedSessions: ReadonlySet<string> = new Set(),
): Promise<HostErrorReport> {
  let bytes: Buffer;
  try {
    bytes = await readFile(logFile);
  } catch {
    // No log yet is no error: a server that has not started has written none.
    return { faults: [], exempted: [], injected: [] };
  }
  // The offset is the size the file had when the run started, and a log that
  // already ended in a partial line leaves it mid-line. Start at the first
  // line boundary after it, so the partial tail is not read as a block and
  // the first complete error of the run is kept.
  let start = Math.max(0, fromOffset);
  if (start > 0 && start < bytes.length && bytes[start - 1] !== 0x0a) {
    const newline = bytes.indexOf(0x0a, start);
    if (newline === -1) return { faults: [], exempted: [], injected: [] };
    start = newline + 1;
  }
  const split = splitHostErrors(
    hostErrorsIn(bytes.subarray(start).toString('utf8')),
    killedSessions,
    faultedSessions,
  );
  return {
    faults: attributeHostErrors(split.faults, sessions),
    exempted: attributeHostErrors(split.exempted, sessions),
    injected: attributeHostErrors(split.injected, sessions),
  };
}

/**
 * The `serve` command the harness starts.
 *
 * `--print-logs` is not decoration: without it the server writes its
 * structured `timestamp=… level=…` lines to the app log in the user's home
 * directory, and the file `stop` reads never receives the ERROR line that
 * would fail the suite.
 */
export function serveArgs(port: number): string[] {
  return ['serve', '--port', String(port), '--hostname', '127.0.0.1', '--print-logs'];
}

async function waitForServer(
  baseUrl: string,
  timeoutMs: number,
  auth?: { user: string; password: string },
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // A per-request timeout, because a fetch with none can hang forever on
      // a connection that opens and never answers, which would outlive the
      // deadline and turn a poll into a hang.
      const response = await fetch(`${baseUrl}/app`, {
        signal: AbortSignal.timeout(2_000),
        ...(auth
          ? {
              headers: {
                Authorization: `Basic ${Buffer.from(`${auth.user}:${auth.password}`).toString('base64')}`,
              },
            }
          : {}),
      });
      if (response.ok) return;
    } catch {
      // The server is not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`the opencode server did not answer on ${baseUrl} within ${timeoutMs}ms`);
}

/**
 * How old a leftover harness file must be before a new run sweeps it.
 *
 * A run holds its database and log while the server is serving. A suite can
 * be re-run back to back, and a slow case can outlive the run before it, so a
 * file that is younger than a day may still belong to a run in progress.
 * Twenty four hours is far longer than any suite run, so a file this old
 * belongs to a run that is over; a fresh one is left strictly alone.
 */
export const HARNESS_SWEEP_AGE_MS = 24 * 60 * 60 * 1000;

/** The prefix every file a harness run names carries, so a sweep can find them. */
const HARNESS_FILE_PREFIX = 'openagentsy-eval-';

/** What the harness creates: the server database and its sidecars, and the log. */
const HARNESS_FILE_SUFFIXES = ['.db', '.db-shm', '.db-wal', '.log'];

/**
 * The files one run owns: its database, the SQLite sidecars beside it, and
 * (when the harness named it) its log.
 */
function harnessFiles(database: string, logFile?: string): string[] {
  const files = [database, `${database}-shm`, `${database}-wal`];
  return logFile === undefined ? files : [...files, logFile];
}

/**
 * Delete the files one run owns, and nothing else.
 *
 * Only paths the harness itself named are passed here: the board database,
 * its records, its leases, and every file outside the harness are never in
 * the list. A file another process still holds is left for a later sweep
 * rather than failing the teardown.
 */
export async function removeHarnessFiles(database: string, logFile?: string): Promise<string[]> {
  const removed: string[] = [];
  for (const file of harnessFiles(database, logFile)) {
    try {
      await rm(file, { force: true });
      removed.push(file);
    } catch {
      // Held by a process that has not exited yet; a later sweep takes it.
    }
  }
  return removed;
}

/**
 * Remove the files earlier runs left in the temp directory.
 *
 * A run killed before `stop` leaves its database and log behind, and the
 * suite starts a fresh one each time. Only a file this harness named and that
 * is older than `HARNESS_SWEEP_AGE_MS` is removed: a file that is not ours, or
 * one a live run is still using, is never touched. A sweep is best effort and
 * never fails the run that starts.
 */
export async function sweepStaleHarnessFiles(
  dir: string = tmpdir(),
  now: number = Date.now(),
): Promise<string[]> {
  const removed: string[] = [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!name.startsWith(HARNESS_FILE_PREFIX)) continue;
    if (!HARNESS_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix))) continue;
    const file = join(dir, name);
    try {
      const info = await stat(file);
      if (!info.isFile()) continue;
      if (now - info.mtimeMs <= HARNESS_SWEEP_AGE_MS) continue;
      await rm(file, { force: true });
      removed.push(file);
    } catch {
      // A file that vanished or is held by a live run is not ours to remove.
    }
  }
  return removed;
}

/**
 * Start one OpenCode server for the whole suite.
 *
 * The server serves any directory it is asked for, so one process can drive
 * every case. Each case gets its own throwaway directory.
 */
export async function startHarness(options: { port?: number } = {}): Promise<OpenCodeHarness> {
  const port = options.port ?? 40_000 + Math.floor(Math.random() * 5_000);
  const baseUrl = `http://127.0.0.1:${port}`;
  // The runtime is named before the server starts, and the run says which
  // one it is: a verdict that cannot name the runtime cannot be read, and
  // the machine may have more than one `opencode` on it.
  const binary = runtimeBinary();
  const runtime = await readRuntime(binary);
  process.stdout.write(`the suite runs ${runtime.binary} ${runtime.version}\n`);

  // The server's output goes to a file even when no log path is given, so a
  // CI run shows why a server that never answered did not answer. `serve` is
  // started with `--print-logs`, so its structured lines go to stderr and
  // land in this file; without the flag they go to the app log in the user's
  // home directory and this file holds only the plain output.
  // A run that was killed leaves its database and log behind. Sweep the
  // leftovers of earlier runs before naming this run's files, so a stale file
  // with this run's port is gone before it is reused. Only files older than
  // `HARNESS_SWEEP_AGE_MS` are swept, so a live run keeps its own.
  await sweepStaleHarnessFiles();

  const logFile =
    process.env.OPENAGENTSY_EVAL_SERVER_LOG ??
    join(tmpdir(), `openagentsy-eval-server-${port}.log`);
  // A log path from the environment belongs to the caller. The harness only
  // removes a log whose name it chose itself.
  const ownsLogFile = process.env.OPENAGENTSY_EVAL_SERVER_LOG === undefined;
  const logFd = openSync(logFile, 'a');
  // Only what this run appends is this run's fault. A log path that already
  // exists would otherwise carry an earlier run's errors into this suite.
  const logStart = fstatSync(logFd).size;

  // OpenCode 2 serves with a password and OpenCode 1 does not, so the
  // password is set for both and sent with every request. The harness talks
  // to the same server API on both, so one harness covers both runtimes.
  const password = process.env.OPENAGENTSY_EVAL_PASSWORD ?? 'openagentsy-eval';

  // The suite gets its own database. Without this the server opens the
  // caller's OpenCode database, and every case leaves its sessions and
  // throwaway project rows in it. Worse, the two runtimes migrate that
  // database to their own schema, so a suite run against OpenCode 2 leaves
  // the caller's OpenCode 1 unable to read it.
  const database = join(tmpdir(), `openagentsy-eval-${port}.db`);

  // The server runs in a directory of its own. It serves whatever directory
  // a request names, so its own working directory is never the project: a
  // server that decides to run a git command where it happens to sit would
  // write into the repository that started the suite.
  const serverCwd = await mkdtemp(join(tmpdir(), 'openagentsy-eval-server-cwd-'));

  const child: ChildProcess = spawn(binary, serveArgs(port), {
    stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
    cwd: serverCwd,
    env: { ...childEnv(), OPENCODE_SERVER_PASSWORD: password, OPENCODE_DB: database },
  });

  try {
    // A cold start under load can take longer than a warm one. 90 seconds
    // covers a machine that is busy starting other servers.
    await waitForServer(baseUrl, 90_000, { user: 'opencode', password });
  } catch (error) {
    child.kill('SIGTERM');
    closeSync(logFd);
    // The database is this run's and is dead weight once the server is gone.
    // The log stays: it is the only record of why the server never answered.
    await removeHarnessFiles(database);
    throw error;
  }

  // The runtime decides which API the harness talks to: OpenCode 1 serves
  // `/session` and OpenCode 2 serves `/api/session`, and the harness's logic
  // sits on this side of that difference.
  const client: HarnessClient =
    runtime.major >= 2
      ? new V2HarnessClient({ baseUrl, password })
      : new V1HarnessClient(
          createOpencodeClient({
            baseUrl,
            headers: {
              Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
            },
          }),
        );

  const watches: { killed: Promise<string | undefined>; stop: () => void }[] = [];
  const sessions = new Map<string, string>();
  // The sessions a case injected a fault into. The server writes that fault
  // as an ERROR naming the session, and the fault is the case's own doing.
  const faultedSessions = new Set<string>();
  const hostErrors = (killedSessions: ReadonlySet<string> = new Set()): Promise<HostErrorReport> =>
    readHostErrors(logFile, logStart, sessions, killedSessions, faultedSessions);

  return {
    client,
    root: baseUrl,
    runtime,
    watches,
    hostErrors,
    idle: new IdleRegistry(),
    trackSession: (sessionID, caseLabel) => {
      sessions.set(sessionID, caseLabel);
    },
    markFaultedSession: (sessionID) => {
      faultedSessions.add(sessionID);
    },
    stop: async () => {
      // A watcher that is still looking for a session stops looking: a
      // pending timer keeps the process alive.
      for (const watch of watches) watch.stop();
      // The sessions the harness killed on purpose are the case's fault, not
      // the host's: the server logs each abort at ERROR. The watches resolve
      // to the id they killed (or undefined when they gave up), so they are
      // the list of errors the cases asked for. Collect it before the server
      // goes away, while an abort that is still in flight can still land.
      const killedSessions = new Set(
        (await Promise.all(watches.map((watch) => watch.killed))).filter(
          (id): id is string => id !== undefined,
        ),
      );
      child.kill('SIGTERM');
      // The server writes to the log file it was given, and it may still be
      // writing when the process is asked to stop. Waiting for the exit
      // closes the file descriptor only after the writer is gone, which is
      // what keeps a teardown from printing a broken pipe.
      await new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve(undefined);
          return;
        }
        child.once('exit', () => resolve(undefined));
        setTimeout(() => resolve(undefined), 5_000).unref?.();
      });
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      closeSync(logFd);
      // The policy from `hostErrorsIn`: a host fault is a failure of the run.
      // Throwing here fails the suite at teardown, so no green case result
      // can hide an error the server wrote while it was serving them. It reads
      // through `hostErrors`, the same view a caller asking mid-run gets, so
      // the log is read before it is removed.
      let report: HostErrorReport = { faults: [], exempted: [], injected: [] };
      try {
        report = await hostErrors(killedSessions);
      } finally {
        // This run's database, sidecars and (when it named it) log are garbage
        // once the server is gone. Nothing else is in the list: not the board
        // database, not its records or leases, and no file that is not ours.
        await removeHarnessFiles(database, ownsLogFile ? logFile : undefined);
        // The server's own directory goes with it.
        await rm(serverCwd, { recursive: true, force: true });
      }
      // The errors the policy exempts are reported: a run that hides the
      // errors it ignored is a run that lies about what happened.
      if (report.exempted.length > 0) {
        process.stdout.write(`${watcherExemptionLine(report.exempted)}\n`);
      }
      if (report.injected.length > 0) {
        process.stdout.write(`${injectedFaultLine(report.injected)}\n`);
      }
      if (report.faults.length > 0) {
        const detail = report.faults
          .map((fault) => `[${fault.case}] ${fault.line.replace(/\n/g, '\n  ')}`)
          .join('\n');
        throw new Error(
          `the opencode server wrote ${report.faults.length} host error(s); a case that passed while the host failed did not measure the agent:\n${detail}`,
        );
      }
    },
  };
}

/**
 * The budget of one trial of a case.
 *
 * A trial is not one turn: it is the Lead's turn, the builder's turn the
 * Lead dispatches, the judge's turn and, in a fault case, a second turn
 * after the fault. Each of those turns may be slow, because the suite runs
 * several cases at once and a turn waits behind the other cases' streams:
 * slow is not hung. The budget is the ceiling of a trial and of one turn
 * inside it, so a turn is never given up before the trial it belongs to
 * would have been given up.
 */
export const TRIAL_BUDGET_MS = 1_800_000;

/**
 * The margin between the budget of a turn and the timeout of a case.
 *
 * The harness gives up on a turn itself, with an error that says what it
 * saw: the session, the idle event, the last message. Vitest gives up on
 * the case, with a line that says nothing. A case whose timeout and whose
 * turn budget are the same number is a race vitest wins, and the harness's
 * diagnosis never reaches the log: the case that hung for thirty minutes
 * reported only "Test timed out in 1800000ms". The margin keeps the
 * harness's own message in the log.
 */
export const TURN_BUDGET_MARGIN_MS = 30_000;

/**
 * A provider refusal the harness is about to retry.
 *
 * The status is the provider's own answer, the attempt counts the retries
 * of the turn, and the wait is how long the harness sleeps before it asks
 * again.
 */
export type ProviderRefusal = {
  /** The status the provider answered with, such as 429. */
  status: number;
  /** Which retry this is, counting from one. */
  attempt: number;
  /** How long the harness waits before it asks again. */
  waitMs: number;
};

export type PromptOptions = {
  harness: OpenCodeHarness;
  directory: string;
  agent: string;
  model?: string;
  text: string;
  /**
   * How long one turn may take, in milliseconds.
   *
   * The default is the budget of a trial, so a turn is only given up when
   * the trial it belongs to would have been.
   */
  timeoutMs?: number;
  /** How many times a rate limited turn is asked again. */
  rateLimitRetries?: number;
  /**
   * Called when the provider refused the turn and the harness is about to
   * ask again.
   *
   * A refusal is the provider's answer, not the agent's, and a run that is
   * slower because the provider refuses looks like a run that is slower
   * because the model is slow. Nothing else in the log tells the two
   * apart, so the refusal is written down.
   */
  onProviderRefusal?: (refusal: ProviderRefusal) => void;
  /**
   * Wait for the board server before the first turn.
   *
   * The board is an MCP server, and the server starts it when a session in
   * that directory begins. A tool call that arrives before the server is
   * up finds no tool.
   */
  waitForBoard?: boolean;
  /**
   * The case points the model provider at a server that fails.
   *
   * The fault lands in the turn of the session this call creates, and the
   * server writes it as an ERROR naming the session. The error is the case
   * proving the fault landed, not the host failing.
   */
  injectsProviderFault?: boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The provider error in a message, when the provider refused the turn.
 *
 * OpenCode records the provider's answer on the assistant message: an
 * APIError with a status code. Anything else is the agent's own output.
 *
 * Every refusal the provider can make is worth asking again: a rate limit
 * (429), an overloaded gateway (502, 503), a provider that dropped the
 * request (500), and a key that is not accepted (401, 403). A case that
 * fails because the provider was busy is a case that measured the provider
 * and not the agent.
 */
function providerErrorOf(message: unknown): number | undefined {
  const info = (message as { info?: { error?: unknown } } | undefined)?.info;
  const error = info?.error as { data?: { statusCode?: number } } | undefined;
  const status = error?.data?.statusCode;
  if (status === undefined) return undefined;
  return status === 401 || status === 403 || status === 429 || status >= 500 ? status : undefined;
}

/**
 * The reply a turn produced.
 *
 * A turn that was rate limited and then asked again has two answers: the
 * provider's refusal and the agent's. The reply is the last one that is not
 * a refusal, so a recovered turn is judged on what the agent said and not on
 * the error the provider sent first.
 */
export function replyPartsOf(messages: readonly unknown[]): {
  text: string;
  toolCalls: { tool: string; input: unknown }[];
} {
  const assistant = messages.filter((message) => {
    const role = (message as { info?: { role?: string } }).info?.role;
    return role === undefined || role === 'assistant';
  });

  // A climb posts a message of its own into the session: the model switch
  // is a synthetic turn, and it carries no reply. The reply is the last
  // assistant message that is not that one, or the turn looks like it
  // produced nothing at all.
  const spoken = assistant.filter((message) => {
    const parts = (message as { parts?: { synthetic?: boolean; ignored?: boolean }[] }).parts ?? [];
    return parts.some((part) => part.synthetic !== true && part.ignored !== true);
  });

  const last = (spoken.at(-1) ?? assistant.at(-1)) as
    | { parts?: { type: string; text?: string; tool?: string; state?: { input?: unknown } }[] }
    | undefined;
  const parts = last?.parts ?? [];

  const text = parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n');

  const toolCalls = parts
    .filter((part) => part.type === 'tool')
    .map((part) => ({
      tool: part.tool ?? '',
      input: part.state?.input as unknown,
    }));

  return { text, toolCalls };
}

/**
 * The environment a child process of the harness gets.
 *
 * The key for a System One model belongs to the harness, which grades the
 * case. A case runs without it: the agent under test must not be able to
 * reach a classifier, or the case measures something else than the agent.
 *
 * The git variables go too. A child that inherits them addresses the
 * repository they point at instead of the one it was told about, and the
 * suite's own repository is the one they point at when the suite runs from
 * a commit.
 */
export function childEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const copy = gitFreeEnv(env);
  delete copy.TYPESAFE_API_KEY;
  return copy;
}

/**
 * Wait for the board server to be connected.
 *
 * The board is an MCP server, and the server starts it when a session in
 * that directory begins. A tool call that arrives before the server is up
 * finds no tool, and the case fails for a reason that has nothing to do
 * with the agent: a warm server reaches the first tool call sooner than a
 * cold one, so a case that passed alone failed in a full run.
 */
export async function waitForBoard(
  harness: OpenCodeHarness,
  directory: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const board = await harness.client.boardStatus({ directory });
    if (board?.status === 'connected') return;
    if (board?.status === 'failed') {
      throw new Error(`the board server failed to start: ${JSON.stringify(board)}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`the board server was not connected within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Run one turn against a real OpenCode session.
 *
 * The session is created in the case directory, so the agents, the plugin and
 * the board of that directory are the ones under test.
 *
 * The turn is asked for asynchronously and the reply is collected from the
 * session, rather than holding one request open. A turn of a real model takes
 * minutes, and a request that is held open for minutes is a request that
 * undici gives up on: it failed a case with a headers timeout after five
 * minutes of a perfectly healthy turn.
 */
export async function runTurn(options: PromptOptions): Promise<SessionTurn> {
  const { harness, directory, agent } = options;
  const client = harness.client;

  const sessionID = await client.createSession({ title: `eval ${agent}`, directory });
  // A host error that names this session belongs to this case. The case is
  // its throwaway directory; the directory is what the suite gives it.
  harness.trackSession(sessionID, basename(directory));
  // A case that injects a fault into its own turn gets the errors of that
  // turn: the server writes the fault as an ERROR naming the session, and
  // the fault is the case's own doing.
  if (options.injectsProviderFault === true) harness.markFaultedSession(sessionID);

  // The board is an MCP server, and the server starts it when a session in
  // that directory begins. A tool call that arrives before the server is up
  // finds no tool, and the case fails for a reason that has nothing to do
  // with the agent: a warm server reaches the first tool call sooner than
  // a cold one, so a case that passed alone failed in a full run.
  if (options.waitForBoard !== false) {
    await waitForBoard(harness, directory);
  }

  const ask = async () => {
    // The idle events that came before this turn are not this turn's: the
    // wait ends on the idle of the turn it waits for.
    harness.idle.beginTurn(sessionID);
    await client.prompt({
      sessionID,
      directory,
      agent,
      ...(options.model !== undefined ? { model: parseModel(options.model) } : {}),
      text: options.text,
    });
  };

  const timeoutMs = options.timeoutMs ?? TRIAL_BUDGET_MS;
  try {
    await ask();

    await waitForIdle({ client, sessionID, directory, timeoutMs, idle: harness.idle });

    // The whole list, not only the last message: a climb puts a synthetic
    // message at the end of the session, and the reply is the message before
    // it.
    let replyFrom: readonly unknown[] = await client.messages({ sessionID, directory });
    const last = replyFrom.at(-1);

    // A rate limited turn is the provider's answer, not the agent's. The free
    // model tiers answer with 429 when a burst trips their limit, so the turn
    // is asked again after a wait. The number of tries is bounded, so a
    // provider that is down for good ends the turn instead of looping.
    const attempts = options.rateLimitRetries ?? 2;
    let providerError = providerErrorOf(last);
    for (let attempt = 0; attempt < attempts && providerError !== undefined; attempt += 1) {
      const waitMs = (attempt + 1) * 30_000;
      // The refusal is written down before the wait, not after it: a run that
      // is slow because the provider refuses has to say so while it is slow.
      // The loop is only entered when the turn was refused, so a turn that
      // answered the first time is never reported.
      options.onProviderRefusal?.({ status: providerError, attempt: attempt + 1, waitMs });
      await sleep(waitMs);
      await ask();
      await waitForIdle({ client, sessionID, directory, timeoutMs, idle: harness.idle });
      const again = await client.messages({ sessionID, directory });
      const recovered = again.at(-1);
      providerError = providerErrorOf(recovered);
      if (providerError === undefined) {
        // The turn came back. The reply is this one, not the refusal that
        // came before it.
        replyFrom = again;
        break;
      }
    }

    const { text, toolCalls } = replyPartsOf(replyFrom);

    return { text, toolCalls, files: [], sessionID };
  } catch (error) {
    if (!isSessionGone(error)) throw error;
    // The session is gone: a case removed it, and the turn produced nothing.
    // The case's own expectations judge that, not the harness.
    return { text: '', toolCalls: [], files: [], sessionID };
  }
}

/** How long the poll of the busy map sleeps between two checks. */
const POLL_INTERVAL_MS = 500;

/** What the wait says about a session that has no assistant message. */
const NO_ASSISTANT_MESSAGE = 'none';

/**
 * What the wait knows about the turn it waits for.
 *
 * A wait that gives up says all of it: a run that hung for thirty minutes
 * reported only that the turn did not finish, and the hunt for the reason
 * took three runs.
 */
type TurnWait = {
  /** The session the turn runs in. */
  sessionID: string;
  /** Whether the server ever reported the session as busy. */
  seenBusy: boolean;
  /** The idle events the server sent for the session since the turn began. */
  idleEvents: number;
  /** What the last assistant message looked like. */
  lastMessage: string;
  /** How long the wait has gone on. */
  waitedMs: number;
};

/** The options of the wait for a turn to end. */
export type WaitForIdleOptions = {
  /** The client the wait asks the server with. */
  client: HarnessClient;
  /** The session the turn runs in. */
  sessionID: string;
  /** The directory the session lives in. */
  directory: string;
  /** How long the wait may take, in milliseconds. */
  timeoutMs: number;
  /** The idle events the event stream carried. */
  idle: IdleRegistry;
  /** How long the poll sleeps between two checks. */
  pollMs?: number;
};

/**
 * Wait until the session has nothing left to do.
 *
 * The server says a session is idle when its turn is over, and the
 * harness's own subscription sees that event: the wait ends when the
 * server says the session under test is idle. The event is matched to the
 * session, because it fires for every session of the case, and the idle of
 * another session ends another session's turn.
 *
 * The poll of the busy map is the fallback for a server that sends no
 * event. The server reports the sessions that are busy, a session that is
 * not in the map is idle, and its last message holds the reply.
 *
 * A turn can also end without a reply: the model streams an empty message
 * and the server never completes it. The session is then idle and the last
 * message is not a finished assistant turn, which means the turn is over and
 * produced nothing. That is a failure of the case, not a wait worth ten
 * minutes: a case that hung that way looked like a slow model.
 */
export async function waitForIdle(options: WaitForIdleOptions): Promise<void> {
  const { client, sessionID, directory, timeoutMs, idle } = options;
  const pollMs = options.pollMs ?? POLL_INTERVAL_MS;
  const started = Date.now();
  const deadline = started + timeoutMs;
  const state: TurnWait = {
    sessionID,
    seenBusy: false,
    idleEvents: 0,
    lastMessage: NO_ASSISTANT_MESSAGE,
    waitedMs: 0,
  };
  for (;;) {
    // The event wins: the server said the session is idle, so the turn is
    // over and the wait does not have to guess it from the busy map.
    state.idleEvents = idle.sinceTurnStart(sessionID);
    if (state.idleEvents > 0) return;
    if (Date.now() >= deadline) break;
    if (await pollOnce(client, sessionID, directory, state)) return;
    await sleep(pollMs);
  }
  state.idleEvents = idle.sinceTurnStart(sessionID);
  state.waitedMs = Date.now() - started;
  // One last look at the messages, so the line names the message of the
  // turn even when the session was busy every time the poll asked.
  state.lastMessage = await lastMessageOf(client, sessionID, directory, state.lastMessage);
  throw new Error(turnWaitMessage(state, timeoutMs));
}

/**
 * The last assistant message of a session, or what the wait already knew.
 *
 * A server that cannot answer right now does not take the diagnosis with
 * it: the line says what the poll saw.
 */
async function lastMessageOf(
  client: HarnessClient,
  sessionID: string,
  directory: string,
  known: string,
): Promise<string> {
  try {
    const messages = await readSessionMessages(client, sessionID, directory);
    return describeMessage(messages.lastAssistant);
  } catch {
    return known;
  }
}

/**
 * One check of the busy map, and of the last message of the session.
 *
 * The check is the fallback for a server that sends no idle event. It says
 * whether the wait is over: a finished assistant message is the reply of
 * the turn, a session that was busy and is not any more has finished, and
 * an assistant message that never completed is a turn that produced
 * nothing.
 */
async function pollOnce(
  client: HarnessClient,
  sessionID: string,
  directory: string,
  state: TurnWait,
): Promise<boolean> {
  const busy = await client.busySessions({ directory });
  if (busy.has(sessionID)) {
    state.seenBusy = true;
    return false;
  }
  const messages = await readSessionMessages(client, sessionID, directory);
  state.lastMessage = describeMessage(messages.lastAssistant);
  const last = messages.last;
  const isAssistant = last?.role === 'assistant';
  if (isAssistant && last?.completed !== undefined) return true;
  if (state.seenBusy) return true;
  return isAssistant;
}

/**
 * The messages of a session, as the wait reads them.
 *
 * The last message is the one the turn is judged on: a session whose last
 * message is a user message has not produced its reply yet, and that is
 * what the retry path relies on. The last assistant message is what a run
 * that waits too long has to describe.
 */
type SessionMessages = {
  /** The last message of the session, whatever its role. */
  last?: MessageSummary;
  /** The last assistant message of the session. */
  lastAssistant?: MessageSummary;
};

/** What a message looks like, for a run that has to say it. */
type MessageSummary = {
  /** The role of the message. */
  role: string;
  /** When the message completed, when it did. */
  completed?: number;
  /** How many parts the message has. */
  parts: number;
  /** How many characters of text the message carries. */
  characters: number;
};

/** Read the messages of a session. */
async function readSessionMessages(
  client: HarnessClient,
  sessionID: string,
  directory: string,
): Promise<SessionMessages> {
  const list = await client.messages({ sessionID, directory });
  let last: MessageSummary | undefined;
  let lastAssistant: MessageSummary | undefined;
  for (const message of list) {
    const summary = summarizeMessage(message);
    if (summary === undefined) continue;
    last = summary;
    if (summary.role === 'assistant') lastAssistant = summary;
  }
  return {
    ...(last === undefined ? {} : { last }),
    ...(lastAssistant === undefined ? {} : { lastAssistant }),
  };
}

/** What one message of a session looks like. */
function summarizeMessage(message: unknown): MessageSummary | undefined {
  const shape = asObject(message);
  if (shape === undefined) return undefined;
  const info = asObject(shape['info']);
  const role = info?.['role'];
  const time = asObject(info?.['time']);
  const completed = time?.['completed'];
  const parts = Array.isArray(shape['parts']) ? shape['parts'] : [];
  let characters = 0;
  for (const part of parts) {
    const text = asObject(part)?.['text'];
    if (typeof text === 'string') characters += text.length;
  }
  return {
    role: typeof role === 'string' ? role : 'unknown',
    ...(typeof completed === 'number' ? { completed } : {}),
    parts: parts.length,
    characters,
  };
}

/** What the last assistant message looked like, in a line. */
function describeMessage(message: MessageSummary | undefined): string {
  if (message === undefined) return NO_ASSISTANT_MESSAGE;
  const shape = `an assistant message with ${message.parts} part(s) and ${message.characters} characters of text`;
  if (message.completed === undefined) return `${shape} that never completed`;
  return `${shape} that completed at ${message.completed}`;
}

/**
 * The line a run reports a turn that did not end with.
 *
 * The harness gives up on a turn with the state it saw, because a run that
 * hung for thirty minutes and reported only that the turn did not finish
 * took three runs to diagnose.
 */
function turnWaitMessage(wait: TurnWait, timeoutMs: number): string {
  return [
    `the turn of session ${wait.sessionID} did not finish within ${timeoutMs}ms`,
    `  the server reported the session busy: ${wait.seenBusy ? 'yes' : 'no'}`,
    `  the server sent an idle event for the session: ${wait.idleEvents > 0 ? 'yes' : 'no'} (${wait.idleEvents} since the turn began)`,
    `  the last assistant message: ${wait.lastMessage}`,
    `  the wait had gone on for ${wait.waitedMs}ms`,
  ].join('\n');
}

/** A model is written provider/model. */
export function parseModel(model: string): { providerID: string; modelID: string } {
  const separator = model.indexOf('/');
  if (separator === -1) throw new Error(`a model must be provider/model, got "${model}"`);
  return {
    providerID: model.slice(0, separator),
    modelID: model.slice(separator + 1),
  };
}

/**
 * The throwaway directories this run created.
 *
 * The suite makes one per case, under the OS temp dir, and the server names
 * the directory in the error it writes when its watcher cannot attach. The
 * fault does not depend on the path, but the report does: this list is what
 * tells the reader whether the watcher failed on a directory of this run or
 * on a path of the machine.
 *
 * A directory stays in the list after its case is over: the error is written
 * while the case runs and read at teardown, when the directory is gone.
 */
const caseDirs = new Set<string>();

/** The throwaway directories this run created. */
export function caseDirsOfRun(): ReadonlySet<string> {
  return caseDirs;
}

/** A throwaway directory for one case. */
export async function createCaseDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `openagentsy-eval-${prefix}-`));
  // The server logs the path it resolved, and on macOS the temp dir is
  // behind a symlink. Both forms are kept, so the error names the directory
  // whichever way it was written.
  caseDirs.add(dir);
  try {
    caseDirs.add(await realpath(dir));
  } catch {
    // A directory that cannot be resolved is still the one the harness made.
  }
  return dir;
}

export async function removeCaseDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

/**
 * A model provider that fails on purpose.
 *
 * The plan's fault kinds include a provider that answers 429 and one that is
 * simply down. Both are the same tiny server with a mode: `429` answers every
 * request with 429, `down` closes the connection. The case's config points a
 * provider at it, and the agent under test runs on that provider.
 */
export type FaultServer = {
  port: number;
  stop: () => Promise<void>;
};

export async function startFaultServer(mode: '429' | 'down'): Promise<FaultServer> {
  const http = await import('node:http');
  const server = http.createServer((request, response) => {
    if (mode === 'down') {
      request.destroy();
      return;
    }
    response.writeHead(429, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'injected fault: rate limited' } }));
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error('the fault server did not get a port'));
    });
  });
  return {
    port,
    stop: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/**
 * How long the kill keeps cutting the session it killed.
 *
 * The abort is what stops the generation that is in flight, and one abort is
 * not always enough: the watch finds the session the moment the dispatch
 * creates it, which is before its turn is running, and an abort of an idle
 * session is a no-op. The session is cut again and again for this long, so
 * a turn that starts after the first abort is cut as well.
 */
const KILL_WINDOW_MS = 60_000;

/**
 * How often the kill cuts the session it killed.
 *
 * The cuts are close together on purpose: a builder that is cut has a
 * window before the next cut, and a window long enough for a tool call is a
 * window long enough for a completion record.
 */
const KILL_INTERVAL_MS = 500;

/**
 * End a session, the way a killed builder stops mid-task.
 *
 * An abort cancels the turn that is running, and the session resumes: the
 * measured run (2026-10-27) had a builder that kept working for 59 seconds
 * after the kill and posted its completion record, and the comment above
 * the watch records a child that generated for nineteen minutes after its
 * abort. Deleting the session ends it: the session is gone, so there is
 * nothing to resume and nothing left to post a record.
 *
 * The aborts come first and they are repeated, and the delete comes last.
 * The order is not a detail. The OpenCode 2 server finds a session by its
 * row, so an abort of a deleted session answers 404 and stops nothing
 * (measured against a live OpenCode 2 server, 2026-10-27). The row has to
 * be there for the aborts to find it, and it has to go in the end, so that
 * there is nothing left to resume.
 *
 * The repeats are not a belt and braces. The watch finds the session the
 * moment the dispatch creates it, and that is before the turn is running,
 * so the first abort lands on an idle session and does nothing. A second
 * abort of a deleted session is worth nothing either, so the aborts have to
 * come before the delete and keep coming.
 *
 * A delete the server refuses leaves the aborts as the only kill there is,
 * so they go on when the delete fails.
 */
export async function killSession(
  client: HarnessClient,
  sessionID: string,
  directory: string,
  options: { windowMs?: number; intervalMs?: number; until?: () => boolean } = {},
): Promise<void> {
  const windowMs = options.windowMs ?? KILL_WINDOW_MS;
  const intervalMs = options.intervalMs ?? KILL_INTERVAL_MS;

  await cutSession(client, sessionID, directory, windowMs, intervalMs, options.until);

  try {
    await client.deleteSession({ sessionID, directory });
  } catch (error) {
    // The server refused the delete, or the client cannot delete: the aborts
    // are all the kill there is, and they go on.
    process.stderr.write(`[kill] the session ${sessionID} was not deleted: ${String(error)}\n`);
    await cutSession(client, sessionID, directory, windowMs, intervalMs, options.until);
  }
}

/**
 * Cut a session, again and again, for a while.
 *
 * Every cut is a separate request and the session may be gone already, in
 * which case the outcome is the one that was wanted. The cut stops early
 * when the caller says the case is over.
 */
async function cutSession(
  client: HarnessClient,
  sessionID: string,
  directory: string,
  windowMs: number,
  intervalMs: number,
  until?: () => boolean,
): Promise<void> {
  for (let elapsed = 0; elapsed < windowMs; elapsed += intervalMs) {
    if (until?.() === true) return;
    try {
      await client.interrupt({ sessionID, directory });
    } catch {
      // The session may be gone already; that is the outcome we wanted.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * The session the fault targets: the builder the Lead dispatched.
 *
 * The title is not a safe signal: OpenCode names a session from the task
 * description, and it does that AFTER the dispatch returns, so a child that
 * works fast is finished before its title exists (measured 2026-10-27: the
 * child wrote its file and posted its completion fourteen seconds after the
 * case started, and the title-based kill arrived after the work was done).
 *
 * The parent is the signal that is there from the start: a dispatched child
 * carries the parent id of the session that dispatched it, while the case's
 * own sessions - the Lead and the judge - are roots, and the archivist, which
 * the Lead dispatches at the end of its turn, says so in its title.
 */
export function selectKillTarget(
  sessions: {
    id?: string | undefined;
    title?: string | undefined;
    parentID?: string | undefined;
  }[],
  baseline: Set<string>,
  matches: (title: string) => boolean,
): string | undefined {
  const target = sessions.find((session) => {
    if (session.id === undefined) return false;
    const title = (session.title ?? '').trim();
    const isChild = session.parentID !== undefined && session.parentID !== null;
    if (isChild) return !/archiv/i.test(title);
    if (title === '') return !baseline.has(session.id);
    return matches(title);
  });
  return target?.id;
}

export function killSessionWhenItAppears(
  client: HarnessClient,
  directory: string,
  matches: (title: string) => boolean,
  options: { attempts?: number; intervalMs?: number; windowMs?: number } = {},
): { killed: Promise<string | undefined>; stop: () => void } {
  // The watch lives until the harness stops it, not for a fixed number of
  // polls: the Lead decides when to dispatch, and that can take minutes
  // (measured 2026-10-27: a watch that gave up after sixty seconds expired
  // before the child appeared, and the fault did not land). The harness
  // stops the watches when the suite ends.
  const attempts = options.attempts ?? Number.POSITIVE_INFINITY;
  const intervalMs = options.intervalMs ?? 500;
  // The kill keeps cutting the session it killed, and the window is how
  // long it does that for. The delete comes at the end of the window, so
  // the session's row is there for every cut: the OpenCode 2 server finds a
  // session by its row, and a cut of a deleted session stops nothing
  // (measured against a live OpenCode 2 server, 2026-10-27). The delete is
  // what makes the kill stay: the session is gone, so there is nothing to
  // resume and nothing left to post a record. Only the killed session is
  // cut; a builder the Lead legitimately re-dispatches is a new session id
  // and is never touched.
  const windowMs = options.windowMs ?? KILL_WINDOW_MS;
  // A dispatched child can finish a small task before the server ever gives
  // it a title (measured 2026-10-27: a one-line hello.txt completed with
  // the session still untitled, the title match never fired, and the fault
  // did not land). The sessions the watch started with are the harness's
  // own - the case's session, an already-running judge - so a session that
  // is NEW since the first poll is the dispatched child, titled or not. A
  // baseline member that gains a matching title later is still caught by
  // the title test, which covers a child that raced into the baseline.
  let baseline: Set<string> | undefined;
  let stopped = false;
  const killed = (async (): Promise<string | undefined> => {
    for (let attempt = 0; attempt < attempts && !stopped; attempt += 1) {
      try {
        const sessions = await client.listSessions({ directory });
        const ids = new Set(sessions.map((session) => session.id));
        if (baseline === undefined) baseline = ids;
        const hit = selectKillTarget(sessions, baseline, matches);
        if (hit !== undefined) {
          // The kill runs beside the watch: the watch says at once which
          // session it found, and the kill keeps cutting that session in the
          // background, because a cut takes a window to be sure.
          void killSession(client, hit, directory, {
            windowMs,
            intervalMs,
            until: () => stopped,
          });
          return hit;
        }
      } catch {
        // A server that is not up yet is not a reason to stop watching.
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return undefined;
  })();
  return {
    killed,
    stop: () => {
      stopped = true;
    },
  };
}
