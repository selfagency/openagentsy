#!/usr/bin/env bun
/**
 * The shape of a live OpenCode 2 plugin context.
 *
 * The v1 hook surface is a map of hook names the host fires. The v2 one is a
 * set of domains, and the question this script answers is the one the port
 * needs: which of the v1 hooks have a v2 equivalent, and what the v2
 * equivalent is called.
 *
 * It is built on `probe-v2-facts.mjs` and it measures the same way: a server
 * of its own, with its own database and its own directory, and a plugin that
 * writes what the server hands it, raw.
 *
 * What it writes:
 *   - the domains of the context, and the keys of each one
 *   - the result of registering a hook on every domain that has a `hook`
 *   - the events of a turn, and the hooks that fired
 *
 * The turn is optional: the shape of the context is measured when the
 * project loads, and a session is enough to load it. Pass `--turn` to drive
 * one turn and see which hooks fire.
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

/** The binary under test. The machine has one on the PATH; a build can be named. */
const args = process.argv.slice(2);
const withTurn = args.includes('--turn');
const named = args.find((arg) => !arg.startsWith('--'));
const binary = named ?? process.env.OPENAGENTSY_PROBE_BIN ?? 'opencode';
const password = 'openagentsy-eval';
const model = { providerID: 'ollama-cloud', id: 'minimax-m3.1-flash' };
const agent = 'build';

/**
 * The hook names to try on every domain that has a `hook`.
 *
 * The names are the v1 spellings and the v2 spellings, and the ones the
 * server's own events use. A name the server does not know is refused, and
 * the refusal says so, which is the answer.
 */
const HOOK_NAMES = [
  'before',
  'after',
  'execute.before',
  'execute.after',
  'pre',
  'post',
  'call',
  'called',
  'evaluate',
  'ask',
  'decide',
  'context',
  'message',
  'message.updated',
  'compact',
  'compacting',
  'session.compacting',
  'text',
  'text.complete',
  'idle',
  'status',
  'env',
  'shell.env',
  'spawn',
  'create',
  'config',
  'options',
  'update',
  'load',
  'permission',
];

/**
 * The probe plugin.
 *
 * It writes the shape of the context and the result of every hook
 * registration to a file: the file is the evidence, and the script reads it
 * after the run.
 */
function probePlugin(logFile) {
  return `import { appendFileSync } from 'node:fs';
const log = ${JSON.stringify(logFile)};
const write = (kind, payload) => {
  try {
    appendFileSync(log, JSON.stringify({ kind, payload }) + '\\n');
  } catch {}
};
const HOOK_NAMES = ${JSON.stringify(HOOK_NAMES)};
export default {
  id: 'oa-v2-surface-probe',
  async setup(ctx) {
    const domains = Object.keys(ctx).sort();
    write('domains', domains);
    for (const domain of domains) {
      const value = ctx[domain];
      write('shape', {
        domain,
        kind: typeof value,
        keys: value && typeof value === 'object' ? Object.keys(value).sort() : [],
      });
    }
    // Every domain that can take a hook is asked to take one, on every name.
    for (const domain of domains) {
      const holder = ctx[domain];
      if (!holder || typeof holder !== 'object') continue;
      if (typeof holder.hook !== 'function') continue;
      for (const name of HOOK_NAMES) {
        try {
          const registration = await holder.hook(name, async (event) => {
            write('fired', { domain, name, event: summarise(event) });
          });
          write('hook-ok', { domain, name, hasDispose: typeof registration?.dispose === 'function' });
        } catch (error) {
          write('hook-error', { domain, name, error: String(error) });
        }
      }
    }
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          write('event', { type: event.type, keys: Object.keys(event).sort(), data: summarise(event.data) });
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

const root = await mkdtemp(join(tmpdir(), 'openagentsy-v2-surface-'));
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

// The roles file the guard reads.
await copyFile(rolesFile, join(project, 'roles.yaml'));
// The adapter of the tree, loaded beside the probe, the way a user loads it.
const bundle = join(here, '..', 'dist', 'index.js');
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

  // A session in the project loads the project, and the project loads the
  // plugin. The shape of the context is measured here.
  const created = await request('POST', '/api/session', {
    title: 'the v2 surface',
    location: { directory: project },
    agent,
    model,
  });
  const sessionID = created.body?.data?.id;
  report.evidence.sessionID = sessionID;
  // The project loads the plugin, and the load is not part of the answer to
  // the session, so the log is waited for.
  let loaded = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const seen = await readFile(logFile, 'utf8');
      if (seen.includes('"kind":"domains"')) {
        loaded = true;
        break;
      }
    } catch {
      /* the plugin has not written yet */
    }
    await sleep(500);
  }
  report.evidence.pluginLoaded = loaded;
  await sleep(2000);

  if (withTurn && sessionID !== undefined) {
    await request('POST', `/api/session/${sessionID}/agent`, { agent });
    await request('POST', `/api/session/${sessionID}/model`, { model });
    await request('POST', `/api/session/${sessionID}/prompt`, {
      text: [
        'Do exactly these two things, one after the other, with the tools:',
        'First use the write tool to create the file leased/ok.txt with the text ok.',
        'Then use the shell tool to run the command echo hello.',
        'Do not read any file and do not explain; just make the two calls.',
      ].join(' '),
      agents: [{ name: agent }],
    });
    await sleep(30000);
  }
} finally {
  report.evidence.serverOutput = serverOutput.slice(-4000);
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), sleep(5000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

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

report.evidence.domains = lines.find((entry) => entry.kind === 'domains')?.payload;
report.evidence.shapes = lines
  .filter((entry) => entry.kind === 'shape')
  .map((entry) => entry.payload);
report.evidence.hookOk = lines
  .filter((entry) => entry.kind === 'hook-ok')
  .map((entry) => entry.payload);
report.evidence.hookErrors = lines
  .filter((entry) => entry.kind === 'hook-error')
  .map((entry) => entry.payload);
report.evidence.fired = lines
  .filter((entry) => entry.kind === 'fired')
  .map((entry) => entry.payload);
report.evidence.events = lines
  .filter((entry) => entry.kind === 'event')
  .map((entry) => entry.payload);
const keep = process.env.OA_PROBE_KEEP === '1';
if (!keep) await rm(root, { recursive: true, force: true });
report.evidence.kept = keep ? root : undefined;

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
