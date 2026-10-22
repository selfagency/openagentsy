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
};

export type OpenCodeHarness = {
  client: OpencodeClient;
  root: string;
  stop: () => Promise<void>;
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

async function waitForServer(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/app`);
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

  const logFile = process.env.OPENAGENTSY_EVAL_SERVER_LOG;
  const logFd =
    logFile === undefined ? undefined : (await import('node:fs')).openSync(logFile, 'a');

  const child: ChildProcess = spawn(
    'opencode',
    ['serve', '--port', String(port), '--hostname', '127.0.0.1'],
    { stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'] },
  );

  try {
    await waitForServer(baseUrl, 30_000);
  } catch (error) {
    child.kill('SIGTERM');
    throw error;
  }

  const client = createOpencodeClient({ baseUrl });

  return {
    client,
    root: baseUrl,
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (!child.killed) child.kill('SIGKILL');
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
};

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

  const timeoutMs = options.timeoutMs ?? 600_000;
  await waitForIdle(client, sessionID, directory, timeoutMs);

  const messages = await client.session.messages({
    path: { id: sessionID },
    query: { directory },
  });
  const parts = messages.data?.at(-1)?.parts ?? [];

  const text = parts
    .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n');

  const toolCalls = parts
    .filter((part): part is Extract<typeof part, { type: 'tool' }> => part.type === 'tool')
    .map((part) => ({
      tool: part.tool,
      input: part.state?.input as unknown,
    }));

  return { text, toolCalls, files: [] };
}

/**
 * Wait until the session has nothing left to do.
 *
 * The server reports the sessions that are busy, so the wait is a poll of
 * that map. A session that is not in it is idle, and its last message holds
 * the reply.
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
    if (busy && Object.hasOwn(busy, sessionID)) {
      reported = true;
    } else if (reported) {
      // The session was busy and is not any more. The turn is over.
      return;
    } else {
      // The session was never reported as busy. The turn may already be
      // over, or it may not have started yet. Give it a moment and look
      // again, so a turn that never starts is a timeout and not a success.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const again = await client.session.status({ query: { directory } });
      const busyNow = again.data as Record<string, unknown> | undefined;
      if (!busyNow || !Object.hasOwn(busyNow, sessionID)) {
        const messages = await client.session.messages({
          path: { id: sessionID },
          query: { directory },
        });
        const last = messages.data?.at(-1);
        if (last?.info?.role === 'assistant' && last.info.time?.completed) return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`the turn did not finish within ${timeoutMs}ms`);
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
