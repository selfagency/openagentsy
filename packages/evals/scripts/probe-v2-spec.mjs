#!/usr/bin/env bun
/**
 * The session routes of a live OpenCode 2 server, read out of the spec the
 * server serves at /openapi.json.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { openSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PASSWORD = 'openagentsy-v2-probe';
const BINARY = process.env.OPENAGENTSY_EVAL_BIN?.trim() || 'opencode';

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

function authorization() {
  return `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`;
}

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
  throw new Error(`the server did not answer on ${baseUrl}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const workdir = await mkdtemp(join(tmpdir(), 'openagentsy-v2-spec-'));
const database = join(workdir, 'probe.db');
const logFile = join(workdir, 'server.log');
const serverCwd = join(workdir, 'server-cwd');
await mkdir(serverCwd);

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const log = openSync(logFile, 'a');
const child = spawn(
  BINARY,
  ['serve', '--port', String(port), '--hostname', '127.0.0.1', '--print-logs'],
  {
    cwd: serverCwd,
    stdio: ['ignore', log, log],
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: PASSWORD, OPENCODE_DB: database },
  },
);

try {
  await waitForServer(baseUrl);
  const response = await fetch(`${baseUrl}/openapi.json`, {
    headers: { Authorization: authorization() },
  });
  const spec = await response.json();
  const out = process.env.SPEC_OUT;
  if (out !== undefined) {
    await writeFile(out, JSON.stringify(spec, null, 2), 'utf8');
    console.log(`the spec is at ${out}`);
  }
  const wanted = process.argv[2] ?? '/api/session';
  for (const [path, methods] of Object.entries(spec.paths)) {
    if (!path.startsWith(wanted)) continue;
    for (const [method, operation] of Object.entries(methods)) {
      if (typeof operation !== 'object' || operation === null) continue;
      const op = operation;
      const body = op.requestBody?.content?.['application/json']?.schema;
      console.log(
        `\n${method.toUpperCase()} ${path}\n  operationId: ${op.operationId ?? ''}\n  summary: ${op.summary ?? ''}\n  description: ${op.description ?? ''}\n  body: ${body === undefined ? '' : JSON.stringify(body)}`,
      );
    }
  }
} catch (error) {
  console.error(`the probe failed: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), sleep(5_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await rm(workdir, { recursive: true, force: true });
}
