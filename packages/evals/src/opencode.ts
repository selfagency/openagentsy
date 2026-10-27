import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, fstatSync, openSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk';
import { gitFreeEnv } from './git-env.js';
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
  /**
   * The host errors the server wrote since it started, each with the case it
   * belongs to. `stop` reads the same list and throws when it is not empty.
   *
   * The sessions the harness killed are excluded: their abort is the fault
   * the case injected, not a host failure.
   */
  hostErrors: (killedSessions?: ReadonlySet<string>) => Promise<HostError[]>;
  /**
   * Say which case a session belongs to, so a host error that names it is
   * attributed instead of falling back to the suite as a whole.
   */
  trackSession: (sessionID: string, caseLabel: string) => void;
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
      // The subscription is scoped to the case directory, so a session that
      // asks here belongs to this case; a host error naming it is attributed.
      harness.trackSession(properties.sessionID, basename(directory));
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
 * The host errors that are faults of the run.
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
 */
export function hostFaults(
  blocks: readonly HostErrorBlock[],
  killedSessions: ReadonlySet<string>,
): HostErrorBlock[] {
  return blocks.filter(
    (block) => block.sessionID === undefined || !killedSessions.has(block.sessionID),
  );
}

/**
 * Read the host errors appended to a log file after a byte offset.
 *
 * The offset is what makes this testable without a server: the caller passes
 * the size the file had when the run started, and only what was appended
 * afterwards is read. A block naming a session the harness killed is the
 * injected fault, not a host error, so it is dropped here.
 */
export async function readHostErrors(
  logFile: string,
  fromOffset = 0,
  sessions: ReadonlyMap<string, string> = new Map(),
  killedSessions: ReadonlySet<string> = new Set(),
): Promise<HostError[]> {
  let bytes: Buffer;
  try {
    bytes = await readFile(logFile);
  } catch {
    // No log yet is no error: a server that has not started has written none.
    return [];
  }
  // The offset is the size the file had when the run started, and a log that
  // already ended in a partial line leaves it mid-line. Start at the first
  // line boundary after it, so the partial tail is not read as a block and
  // the first complete error of the run is kept.
  let start = Math.max(0, fromOffset);
  if (start > 0 && start < bytes.length && bytes[start - 1] !== 0x0a) {
    const newline = bytes.indexOf(0x0a, start);
    if (newline === -1) return [];
    start = newline + 1;
  }
  return attributeHostErrors(
    hostFaults(hostErrorsIn(bytes.subarray(start).toString('utf8')), killedSessions),
    sessions,
  );
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

  const child: ChildProcess = spawn('opencode', serveArgs(port), {
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

  const client = createOpencodeClient({
    baseUrl,
    headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` },
  });

  const watches: { killed: Promise<string | undefined>; stop: () => void }[] = [];
  const sessions = new Map<string, string>();
  const hostErrors = (killedSessions: ReadonlySet<string> = new Set()): Promise<HostError[]> =>
    readHostErrors(logFile, logStart, sessions, killedSessions);

  return {
    client,
    root: baseUrl,
    watches,
    hostErrors,
    trackSession: (sessionID, caseLabel) => {
      sessions.set(sessionID, caseLabel);
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
      let faults: HostError[] = [];
      try {
        faults = await hostErrors(killedSessions);
      } finally {
        // This run's database, sidecars and (when it named it) log are garbage
        // once the server is gone. Nothing else is in the list: not the board
        // database, not its records or leases, and no file that is not ours.
        await removeHarnessFiles(database, ownsLogFile ? logFile : undefined);
        // The server's own directory goes with it.
        await rm(serverCwd, { recursive: true, force: true });
      }
      if (faults.length > 0) {
        const detail = faults
          .map((fault) => `[${fault.case}] ${fault.line.replace(/\n/g, '\n  ')}`)
          .join('\n');
        throw new Error(
          `the opencode server wrote ${faults.length} host error(s); a case that passed while the host failed did not measure the agent:\n${detail}`,
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
  // A host error that names this session belongs to this case. The case is
  // its throwaway directory; the directory is what the suite gives it.
  harness.trackSession(sessionID, basename(directory));

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

  const timeoutMs = options.timeoutMs ?? TRIAL_BUDGET_MS;
  await waitForIdle(client, sessionID, directory, timeoutMs);

  const messages = await client.session.messages({
    path: { id: sessionID },
    query: { directory },
  });
  const last = messages.data?.at(-1);
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
    const waitMs = (attempt + 1) * 30_000;
    // The refusal is written down before the wait, not after it: a run that
    // is slow because the provider refuses has to say so while it is slow.
    // The loop is only entered when the turn was refused, so a turn that
    // answered the first time is never reported.
    options.onProviderRefusal?.({ status: providerError, attempt: attempt + 1, waitMs });
    await sleep(waitMs);
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
  client: OpencodeClient,
  directory: string,
  matches: (title: string) => boolean,
  options: { attempts?: number; intervalMs?: number; suppressMs?: number } = {},
): { killed: Promise<string | undefined>; stop: () => void } {
  // The watch lives until the harness stops it, not for a fixed number of
  // polls: the Lead decides when to dispatch, and that can take minutes
  // (measured 2026-10-27: a watch that gave up after sixty seconds expired
  // before the child appeared, and the fault did not land). The harness
  // stops the watches when the suite ends.
  const attempts = options.attempts ?? Number.POSITIVE_INFINITY;
  const intervalMs = options.intervalMs ?? 500;
  // An abort cancels the session's in-flight generation, but the session's
  // loop can resume right after (measured 2026-10-27: a builder child kept
  // generating for nineteen minutes after its abort, and the transcript it
  // grew was what the judge could no longer answer). Keep aborting the SAME
  // session for a while after the first kill: an abort of an idle session
  // is a no-op, and a resumed one is cut again. Only the killed session is
  // re-aborted; a builder the Lead legitimately re-dispatches is a new
  // session id and is never touched.
  const suppressMs = options.suppressMs ?? 60_000;
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
  const suppress = async (id: string): Promise<void> => {
    for (let elapsed = 0; elapsed < suppressMs && !stopped; elapsed += intervalMs) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      if (stopped) return;
      try {
        await client.session.abort({ path: { id }, query: { directory } });
      } catch {
        // The session may be gone already; that is the outcome we wanted.
      }
    }
  };
  const killed = (async (): Promise<string | undefined> => {
    for (let attempt = 0; attempt < attempts && !stopped; attempt += 1) {
      try {
        const listed = await client.session.list({ query: { directory } });
        const sessions = listed.data ?? [];
        const ids = new Set(
          sessions.map((session) => session.id).filter((id): id is string => id !== undefined),
        );
        if (baseline === undefined) baseline = ids;
        const hit = selectKillTarget(sessions, baseline, matches);
        if (hit !== undefined) {
          await client.session.abort({ path: { id: hit }, query: { directory } });
          void suppress(hit);
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
