#!/usr/bin/env bun
/**
 * The proof that the OpenCode 2 client works against a real server.
 *
 * The client is written on `fetch` and every shape it reads was captured
 * from a live server, so the shapes can be right and the client still not
 * work. This script starts a real OpenCode 2 server of its own, with its
 * own database and its own directory, and drives the client against it:
 * the server info, a session, the list of sessions, the MCP status, two
 * seconds of the event stream, and the delete of the session.
 *
 * No provider is needed for any of that. Creating a session, reading the
 * MCP status and watching the event stream never call a model.
 *
 * The server, its database and its log are the run's own, and they go
 * when the run is over.
 *
 * Run it with: bun packages/evals/scripts/probe-v2-client.mjs
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { openSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { V2Client } from '../src/v2client.ts';

const PASSWORD = 'openagentsy-v2-probe';
const BINARY = process.env.OPENAGENTSY_EVAL_BIN?.trim() || 'opencode';

/** A port nothing is listening on. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** The header the server wants when it was started with a password. */
function authorization() {
  return `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`;
}

/** Wait until the server answers, or say that it never did. */
async function waitForServer(baseUrl, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/info`, {
        headers: { Authorization: authorization() },
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {
      // The server is not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`the opencode server did not answer on ${baseUrl} within ${timeoutMs}ms`);
}

/** Wait for a while. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Print what a call answered. */
function show(name, value) {
  console.log(`\n== ${name} ==`);
  console.log(JSON.stringify(value, null, 2));
}

const workdir = await mkdtemp(join(tmpdir(), 'openagentsy-v2-probe-'));
const database = join(workdir, 'probe.db');
const logFile = join(workdir, 'server.log');
const serverCwd = join(workdir, 'server-cwd');
const caseDir = join(workdir, 'case');
await mkdir(serverCwd);
await mkdir(caseDir);

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const log = openSync(logFile, 'a');

console.log(`the server runs on ${baseUrl} with its own database at ${database}`);

const child = spawn(
  BINARY,
  ['serve', '--port', String(port), '--hostname', '127.0.0.1', '--print-logs'],
  {
    cwd: serverCwd,
    stdio: ['ignore', log, log],
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: PASSWORD, OPENCODE_DB: database },
  },
);

let failed = false;
try {
  await waitForServer(baseUrl);
  const client = new V2Client({ baseUrl, password: PASSWORD, directory: caseDir });

  show('info', await client.info());

  const session = await client.createSession({ title: 'v2 probe session' });
  show('createSession', session);

  const list = await client.listSessions();
  show('listSessions', {
    count: list.sessions.length,
    ids: list.sessions.map((one) => one.id),
    cursor: list.cursor,
  });

  const mcp = await client.mcpStatus();
  show('mcpStatus', {
    directory: mcp.directory,
    servers: mcp.servers.map((server) => ({
      name: server.name,
      status: server.status.status,
    })),
  });

  // Two seconds of the event stream, and a cancel: a subscription that is
  // not closed leaves the socket open, and the run must not leak one.
  const stream = await client.events();
  const events = [];
  const collected = (async () => {
    for await (const event of stream) {
      events.push({ type: event.type, id: event.id, created: event.created });
    }
  })();
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  await stream.close();
  await collected;
  show('events', { received: events.length, events });

  await client.deleteSession(session.id);
  show('deleteSession', { deleted: session.id });

  const after = await client.listSessions();
  show('listSessions after the delete', {
    count: after.sessions.length,
    ids: after.sessions.map((one) => one.id),
  });

  console.log('\nthe client drove a live opencode 2 server');
} catch (error) {
  failed = true;
  console.error(`\nthe probe failed: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  child.kill('SIGTERM');
  // The server may still be writing to the log when it is asked to stop, so
  // the wait for the exit is what keeps the teardown quiet. Five seconds is
  // the ceiling; a server that outlives it is killed.
  await Promise.race([once(child, 'exit'), sleep(5_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  // The server's own files go with it: the database, its sidecars and the
  // log. Nothing outside the directory this run made is touched.
  await rm(workdir, { recursive: true, force: true });
  console.log(`\nthe server, its database and its log are gone: ${workdir} was removed`);
}

process.exit(failed ? 1 : 0);
