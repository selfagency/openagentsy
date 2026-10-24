import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk';
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
  client: OpencodeClient;
  root: string;
  stop: () => Promise<void>;
  /**
   * The faults that are still watching.
   *
   * A watcher outlives the turn that started it, so the harness keeps it
   * here and waits for it when the case ends. A watcher that is dropped
   * keeps polling after the case is gone.
   */
  watches: { killed: Promise<string | undefined>; stop: () => void }[];
};

/**
 * How a permission request is answered.
 *
 * The Lead asks before it runs a shell command, and in a headless session
 * nobody is there to answer, so the tool call waits forever. The harness
 * answers, the way the user in the case would.
 */
export type PermissionPolicy = (request: {
  sessionID: string;
  permissionID: string;
  title: string;
  type: string;
  patterns: string[];
}) => 'once' | 'always' | 'reject';

const DEFAULT_PERMISSION: PermissionPolicy = () => 'once';

/**
 * Watch the server for permission requests and answer them.
 *
 * The event stream is scoped to a directory, so one subscription serves one
 * case. Without an answer the first shell command of a case waits forever,
 * which looks like a slow model and is not.
 */
export async function answerPermissions(
  harness: OpenCodeHarness,
  directory: string,
  policy: PermissionPolicy = DEFAULT_PERMISSION,
): Promise<() => void> {
  const stream = await harness.client.event.subscribe({ query: { directory } });
  let stopped = false;

  const pump = async (): Promise<void> => {
    for await (const event of stream.stream) {
      if (stopped) return;
      if (process.env.OPENAGENTSY_EVAL_TRACE) {
        const { appendFileSync } = await import('node:fs');
        appendFileSync(
          process.env.OPENAGENTSY_EVAL_TRACE,
          `${new Date().toISOString()} ${event.type}\n`,
        );
      }
      if (event.type !== 'permission.updated') continue;
      const properties = event.properties as {
        id: string;
        sessionID: string;
        title?: string;
        type?: string;
        patterns?: string[];
      };
      const response = policy({
        sessionID: properties.sessionID,
        permissionID: properties.id,
        title: properties.title ?? '',
        type: properties.type ?? '',
        patterns: properties.patterns ?? [],
      });
      await harness.client.postSessionIdPermissionsPermissionId({
        path: { id: properties.sessionID, permissionID: properties.id },
        body: { response },
        query: { directory },
      });
    }
  };

  void pump().catch(() => {
    // The server went away first, which happens at teardown.
  });

  return () => {
    stopped = true;
  };
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
 * Start one OpenCode server for the whole suite.
 *
 * The server serves any directory it is asked for, so one process can drive
 * every case. Each case gets its own throwaway directory.
 */
export async function startHarness(options: { port?: number } = {}): Promise<OpenCodeHarness> {
  const port = options.port ?? 40_000 + Math.floor(Math.random() * 5_000);
  const baseUrl = `http://127.0.0.1:${port}`;

  // The server's output goes to a file even when no log path is given, so a
  // CI run shows why a server that never answered did not answer.
  const logFile =
    process.env.OPENAGENTSY_EVAL_SERVER_LOG ??
    join(tmpdir(), `openagentsy-eval-server-${port}.log`);
  const logFd = (await import('node:fs')).openSync(logFile, 'a');

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

  const child: ChildProcess = spawn(
    'opencode',
    ['serve', '--port', String(port), '--hostname', '127.0.0.1'],
    {
      stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
      env: { ...childEnv(), OPENCODE_SERVER_PASSWORD: password, OPENCODE_DB: database },
    },
  );

  try {
    // A cold start under load can take longer than a warm one. 90 seconds
    // covers a machine that is busy starting other servers.
    await waitForServer(baseUrl, 90_000, { user: 'opencode', password });
  } catch (error) {
    child.kill('SIGTERM');
    throw error;
  }

  const client = createOpencodeClient({
    baseUrl,
    headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` },
  });

  const watches: { killed: Promise<string | undefined>; stop: () => void }[] = [];

  return {
    client,
    root: baseUrl,
    watches,
    stop: async () => {
      // A watcher that is still looking for a session stops looking: a
      // pending timer keeps the process alive.
      for (const watch of watches) watch.stop();
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
      (await import('node:fs')).closeSync(logFd);
    },
  };
}

export type PromptOptions = {
  harness: OpenCodeHarness;
  directory: string;
  agent: string;
  model?: string;
  text: string;
  timeoutMs?: number;
  /** How many times a rate limited turn is asked again. */
  rateLimitRetries?: number;
  /**
   * Wait for the board server before the first turn.
   *
   * The board is an MCP server, and the server starts it when a session in
   * that directory begins. A tool call that arrives before the server is
   * up finds no tool.
   */
  waitForBoard?: boolean;
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
 */
export function childEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const copy: Record<string, string | undefined> = { ...env };
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
    const status = await harness.client.mcp.status({ query: { directory } });
    const servers = status.data ?? {};
    const board = servers.openagentsy;
    if (board !== undefined && 'status' in board && board.status === 'connected') return;
    if (board !== undefined && 'status' in board && board.status === 'failed') {
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

  const created = await client.session.create({
    body: { title: `eval ${agent}` },
    query: { directory },
  });
  if (created.error) {
    throw new Error(`could not create a session: ${JSON.stringify(created.error)}`);
  }
  const sessionID = created.data?.id;
  if (sessionID === undefined) {
    throw new Error('the server created a session without an id');
  }

  // The board is an MCP server, and the server starts it when a session in
  // that directory begins. A tool call that arrives before the server is up
  // finds no tool, and the case fails for a reason that has nothing to do
  // with the agent: a warm server reaches the first tool call sooner than
  // a cold one, so a case that passed alone failed in a full run.
  if (options.waitForBoard !== false) {
    await waitForBoard(harness, directory);
  }

  const ask = async () => {
    const asked = await client.session.promptAsync({
      path: { id: sessionID },
      body: {
        agent,
        ...(options.model !== undefined ? { model: parseModel(options.model) } : {}),
        parts: [{ type: 'text', text: options.text }],
      },
      query: { directory },
    });
    if (asked.error) {
      throw new Error(`the prompt failed: ${JSON.stringify(asked.error)}`);
    }
  };

  await ask();

  const timeoutMs = options.timeoutMs ?? 600_000;
  await waitForIdle(client, sessionID, directory, timeoutMs);

  const messages = await client.session.messages({
    path: { id: sessionID },
    query: { directory },
  });
  let last = messages.data?.at(-1);
  // The whole list, not only the last message: a climb puts a synthetic
  // message at the end of the session, and the reply is the message before
  // it.
  let replyFrom: readonly unknown[] = messages.data ?? [];

  // A rate limited turn is the provider's answer, not the agent's. The free
  // model tiers answer with 429 when a burst trips their limit, so the turn
  // is asked again after a wait. The number of tries is bounded, so a
  // provider that is down for good ends the turn instead of looping.
  const attempts = options.rateLimitRetries ?? 2;
  let providerError = providerErrorOf(last);
  for (let attempt = 0; attempt < attempts && providerError !== undefined; attempt += 1) {
    await sleep((attempt + 1) * 30_000);
    await ask();
    await waitForIdle(client, sessionID, directory, timeoutMs);
    const again = await client.session.messages({
      path: { id: sessionID },
      query: { directory },
    });
    const recovered = again.data?.at(-1);
    providerError = providerErrorOf(recovered);
    if (providerError === undefined) {
      // The turn came back. The reply is this one, not the refusal that
      // came before it.
      last = recovered;
      replyFrom = again.data ?? [];
      break;
    }
  }

  const { text, toolCalls } = replyPartsOf(replyFrom);

  return { text, toolCalls, files: [], sessionID };
}
/**
 * Wait until the session has nothing left to do.
 *
 * The server reports the sessions that are busy, so the wait is a poll of
 * that map. A session that is not in it is idle, and its last message holds
 * the reply.
 *
 * A turn can also end without a reply: the model streams an empty message
 * and the server never completes it. The session is then idle and the last
 * message is not a finished assistant turn, which means the turn is over and
 * produced nothing. That is a failure of the case, not a wait worth ten
 * minutes: a case that hung that way looked like a slow model.
 */
async function waitForIdle(
  client: OpencodeClient,
  sessionID: string,
  directory: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let reported = false;
  while (Date.now() < deadline) {
    const status = await client.session.status({ query: { directory } });
    const busy = status.data as Record<string, unknown> | undefined;
    const isBusy = busy !== undefined && Object.hasOwn(busy, sessionID);

    if (isBusy) {
      reported = true;
    } else {
      const last = await lastAssistantMessage(client, sessionID, directory);
      if (last?.info?.time?.completed) return;
      // The session is idle and the last assistant message never completed.
      // Either the turn is over with nothing in it, or it has not started.
      if (reported) return;
      if (last !== undefined) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`the turn did not finish within ${timeoutMs}ms`);
}

async function lastAssistantMessage(
  client: OpencodeClient,
  sessionID: string,
  directory: string,
): Promise<{ info?: { role?: string; time?: { completed?: number } } } | undefined> {
  const messages = await client.session.messages({
    path: { id: sessionID },
    query: { directory },
  });
  const last = messages.data?.at(-1);
  if (last?.info?.role !== 'assistant') return undefined;
  return {
    info: {
      role: last.info.role,
      ...(last.info.time?.completed !== undefined
        ? { time: { completed: last.info.time.completed } }
        : {}),
    },
  };
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

/** A throwaway directory for one case. */
export async function createCaseDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `openagentsy-eval-${prefix}-`));
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

/** Abort a session's turn, the way a killed builder stops mid-task. */
export async function abortSession(
  client: OpencodeClient,
  sessionID: string,
  directory: string,
): Promise<void> {
  await client.session.abort({ path: { id: sessionID }, query: { directory } });
}

/**
 * Kill a session the moment it appears, and keep watching until it does.
 *
 * A fault that fires between two turns fires after the work is done: the
 * builder had already written its file and posted its completion record
 * before the harness got a turn to kill it, and the agent under test
 * could not tell the difference. A watcher runs while the turn runs, so
 * the kill lands in the middle of the work.
 *
 * The promise settles when the session was killed, or when the watch gave
 * up. It never rejects: a fault that cannot fire is a case that says so,
 * not a run that crashes.
 */
export function killSessionWhenItAppears(
  client: OpencodeClient,
  directory: string,
  matches: (title: string) => boolean,
  options: { attempts?: number; intervalMs?: number } = {},
): { killed: Promise<string | undefined>; stop: () => void } {
  const attempts = options.attempts ?? 120;
  const intervalMs = options.intervalMs ?? 500;
  let stopped = false;
  const killed = (async (): Promise<string | undefined> => {
    for (let attempt = 0; attempt < attempts && !stopped; attempt += 1) {
      try {
        const listed = await client.session.list({ query: { directory } });
        const hit = (listed.data ?? []).find(
          (session) => session.title !== undefined && matches(session.title),
        );
        if (hit?.id !== undefined) {
          await client.session.abort({ path: { id: hit.id }, query: { directory } });
          return hit.id;
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
