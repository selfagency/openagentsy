#!/usr/bin/env bun
import { Database } from 'bun:sqlite';
/**
 * What the V2 tool hook can do, and what the shell hook is called.
 *
 * The surface probe found the hook points: the V2 tool hook fires with the
 * V1 names, `tool.execute.before` and `tool.execute.after`, and it carries
 * the tool name, the arguments, the agent and the call id. Three questions
 * are left, and this script measures them on a live server:
 *
 *   1. Does a throw in `tool.execute.before` stop the call? The V1 path
 *      blocked a call by throwing, and the seven blocking rules need the
 *      same power.
 *   2. Does a change to the arguments of the event reach the tool? The V1
 *      path rewrote the arguments in place.
 *   3. Which name, if any, the shell hook fires under. The V1 path had a
 *      `shell.env` hook that tightened the environment of the shell.
 *
 * The turn does three things: a write whose arguments the probe rewrites, a
 * write the probe refuses, and a shell command. The files the turn leaves
 * behind are the answer.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rolesFile = join(here, '..', '..', '..', 'roles.yaml');
const bundle = join(here, '..', 'dist', 'index.js');

const args = process.argv.slice(2);
const named = args.find((arg) => !arg.startsWith('--'));
const binary = named ?? process.env.OPENAGENTSY_PROBE_BIN ?? 'opencode';
const keep = process.env.OA_PROBE_KEEP === '1';
const password = 'openagentsy-eval';
const model = { providerID: 'ollama-cloud', id: 'minimax-m3.1-flash' };
const agent = 'build';

/** The names the shell hook is asked for. */
const SHELL_NAMES = [
  'env',
  'environment',
  'shell.env',
  'created',
  'exited',
  'spawn',
  'exec',
  'run',
  'process',
  'shell',
  'command',
  'start',
  'finish',
  'input',
  'output',
  'result',
  'before',
  'after',
  'execute',
];

/** The names the session hook is asked for. */
const SESSION_NAMES = [
  'text.complete',
  'text.delta',
  'text.ended',
  'response',
  'reply',
  'complete',
  'compaction',
  'compact.before',
  'message.part.updated',
  'experimental.text.complete',
  'experimental.session.compacting',
];

/**
 * The probe plugin.
 *
 * It rewrites the arguments of one write, refuses another, and asks the
 * shell hook for a name.
 */
function probePlugin(logFile) {
  return `import { appendFileSync } from 'node:fs';
const log = ${JSON.stringify(logFile)};
const write = (kind, payload) => {
  try {
    appendFileSync(log, JSON.stringify({ kind, payload }) + '\\n');
  } catch {}
};
const SHELL_NAMES = ${JSON.stringify(SHELL_NAMES)};
const SESSION_NAMES = ${JSON.stringify(SESSION_NAMES)};
export default {
  id: 'oa-v2-hooks-probe',
  async setup(ctx) {
    for (const name of SHELL_NAMES) {
      try {
        await ctx.shell.hook(name, async (event) => {
          write('fired', { domain: 'shell', name, event: summarise(event) });
        });
      } catch (error) {
        write('hook-error', { domain: 'shell', name, error: String(error) });
      }
    }
    for (const name of SESSION_NAMES) {
      try {
        await ctx.session.hook(name, async (event) => {
          write('fired', { domain: 'session', name, event: summarise(event) });
        });
      } catch (error) {
        write('hook-error', { domain: 'session', name, error: String(error) });
      }
    }
    await ctx.tool.hook('execute.before', async (event) => {
      write('before', summarise(event));
      const input = event.input;
      if (input && typeof input === 'object') {
        const path = input.path;
        if (path === 'leased/mutated.txt') {
          input.content = 'the probe rewrote this';
          write('mutated', { path });
        }
        if (path === 'leased/blocked.txt') {
          write('throwing', { path });
          throw new Error('the probe refused this call');
        }
      }
    });
    await ctx.tool.hook('execute.after', async (event) => {
      write('after', summarise(event));
    });
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          write('event', { type: event.type });
        }
      } catch (error) {
        write('event-error', String(error));
      }
    })();
    return () => controller.abort();
  },
};
function summarise(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return { array: value.length, sample: value.slice(0, 3) };
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).slice(0, 24)) {
      const item = value[key];
      out[key] = Array.isArray(item) ? { array: item.length, sample: item.slice(0, 2) } : item;
    }
    return out;
  }
  return value;
}
`;
}

const root = await mkdtemp(join(tmpdir(), 'openagentsy-v2-hooks-'));
const project = join(root, 'project');
const xdg = join(root, 'xdg');
const logFile = join(root, 'probe-events.jsonl');
await mkdir(join(project, '.opencode', 'plugins'), { recursive: true });
await mkdir(join(project, '.openagentsy'), { recursive: true });
await mkdir(xdg);

await writeFile(
  join(project, 'opencode.json'),
  JSON.stringify({ $schema: 'https://opencode.ai/config.json' }, null, 2),
);
await copyFile(rolesFile, join(project, 'roles.yaml'));

// The board with one lease, so a write inside the leased path is allowed.
const board = new Database(join(project, '.openagentsy', 'board.sqlite'));
board.exec(
  'CREATE TABLE leases (id integer PRIMARY KEY AUTOINCREMENT, bean text NOT NULL, agent text NOT NULL, glob text NOT NULL, granted_at text NOT NULL);' +
    'CREATE UNIQUE INDEX leases_agent_glob ON leases (agent, glob);',
);
board.run('INSERT INTO leases (bean, agent, glob, granted_at) VALUES (?, ?, ?, ?)', [
  '2d-8-probe',
  agent,
  'leased/**',
  new Date().toISOString(),
]);
board.close();

if (existsSync(bundle)) {
  await copyFile(bundle, join(project, '.opencode', 'plugins', 'openagentsy.js'));
}
await writeFile(join(project, '.opencode', 'plugins', 'probe.js'), probePlugin(logFile));

const port = await new Promise((resolve, reject) => {
  const server = createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close(() => resolve(typeof address === 'object' && address !== null ? address.port : 0));
  });
});
const base = `http://127.0.0.1:${port}`;

const child = spawn(binary, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
  cwd: project,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_DB: join(root, 'probe.db'),
    XDG_CONFIG_HOME: xdg,
  },
});
let serverOutput = '';
child.stdout?.on('data', (chunk) => {
  serverOutput += String(chunk);
});
child.stderr?.on('data', (chunk) => {
  serverOutput += String(chunk);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function authorization() {
  return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
}
async function request(method, path, body) {
  const headers = { Authorization: authorization() };
  const init = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
}

const report = { evidence: {} };

try {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/info`, {
        headers: { Authorization: authorization() },
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }

  const created = await request('POST', '/api/session', {
    title: 'the v2 hooks',
    location: { directory: project },
    agent,
    model,
  });
  const sessionID = created.body?.data?.id;
  report.evidence.sessionID = sessionID;
  await sleep(2000);

  await request('POST', `/api/session/${sessionID}/agent`, { agent });
  await request('POST', `/api/session/${sessionID}/model`, { model });
  await request('POST', `/api/session/${sessionID}/prompt`, {
    text: [
      'Do exactly these three things, one after the other, with the tools:',
      'First use the write tool to create the file leased/mutated.txt with the text original.',
      'Then use the write tool to create the file leased/blocked.txt with the text no.',
      'Then use the shell tool to run the command echo hello.',
      'Do not read any file and do not explain; just make the three calls.',
    ].join(' '),
    agents: [{ name: agent }],
  });

  // The turn is over when the assistant message carries a completed time.
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const listed = await request('GET', `/api/session/${sessionID}/message`);
    const messages =
      listed.body?.data?.messages ?? listed.body?.data ?? listed.body?.messages ?? [];
    const found = messages.find(
      (message) => message?.type === 'assistant' && message?.time?.completed !== undefined,
    );
    if (found !== undefined) break;
    await sleep(1000);
  }
  await sleep(3000);
} finally {
  report.evidence.serverOutput = serverOutput.slice(-4000);
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), sleep(5000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

// What the turn left behind: the answer to the three questions.
const files = {};
for (const name of ['leased/mutated.txt', 'leased/blocked.txt']) {
  try {
    files[name] = await readFile(join(project, name), 'utf8');
  } catch {
    files[name] = undefined;
  }
}
report.evidence.files = files;

let raw = '';
try {
  raw = await readFile(logFile, 'utf8');
} catch {
  /* the plugin never ran */
}
const lines = raw
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return undefined;
    }
  })
  .filter((entry) => entry !== undefined);
report.evidence.fired = lines
  .filter((entry) => entry.kind === 'fired')
  .map((entry) => entry.payload);
report.evidence.before = lines
  .filter((entry) => entry.kind === 'before')
  .map((entry) => entry.payload);
report.evidence.after = lines
  .filter((entry) => entry.kind === 'after')
  .map((entry) => entry.payload);
report.evidence.throwing = lines
  .filter((entry) => entry.kind === 'throwing')
  .map((entry) => entry.payload);
report.evidence.mutated = lines
  .filter((entry) => entry.kind === 'mutated')
  .map((entry) => entry.payload);
report.evidence.eventTypes = lines
  .filter((entry) => entry.kind === 'event')
  .map((entry) => entry.payload?.type);

if (!keep) await rm(root, { recursive: true, force: true });
report.evidence.kept = keep ? root : undefined;

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
