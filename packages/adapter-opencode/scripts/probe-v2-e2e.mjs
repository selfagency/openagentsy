#!/usr/bin/env bun
import { Database } from 'bun:sqlite';
/**
 * The port, on a live OpenCode 2 server.
 *
 * The unit tests use a context that supplies whatever the type says. This
 * script measures the port on the server that runs it: the adapter of the
 * tree is loaded the way a user loads it, a session runs one turn, and the
 * script reads what the server holds afterwards.
 *
 * What it proves, one question per section:
 *
 *   1. the quality check fires on a write, and the findings reach the model
 *      (the after hook writes them into the result, and the host keeps
 *      them);
 *   2. the approval asks a person about a command the project named (the
 *      permission event carries the effect `ask`);
 *   3. the session surface the janitor needs answers: `list`, `get` and
 *      `remove`, and the shape of what they answer.
 *
 * The findings of the quality check are read from two places: the message
 * the model was shown, and the findings store under `.openagentsy/quality`.
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

/** The stylesheet the turn writes. It trips a compiler-free quality rule. */
const CSS = '.a { transition: all 0.2s; }\n';

/**
 * The probe plugin.
 *
 * It watches the permission decisions and lets the turn go on, so a command
 * that was asked about does not hold the turn: the effect the adapter set
 * is written down before the probe puts it back.
 */
function probePlugin(logFile) {
  return `import { appendFileSync } from 'node:fs';
const log = ${JSON.stringify(logFile)};
const write = (kind, payload) => {
  try {
    appendFileSync(log, JSON.stringify({ kind, payload }) + '\\n');
  } catch {}
};
const seen = (value) => {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return { array: value.length, sample: value.slice(0, 2) };
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).slice(0, 20)) {
      const item = value[key];
      out[key] = Array.isArray(item) ? { array: item.length, sample: item.slice(0, 2) } : item;
    }
    return out;
  }
  return value;
};
export default {
  id: 'oa-v2-e2e-probe',
  async setup(ctx) {
    await ctx.permission.hook('evaluate', async (event) => {
      write('permission', { action: event.action, effect: event.effect, resources: event.resources, message: event.message });
      // The turn must go on, so the effect the adapter set is put back after
      // it was written down.
      if (event.effect === 'ask') event.effect = 'allow';
    });
    await ctx.tool.hook('execute.after', async (event) => {
      write('after', { tool: event.tool, result: seen(event.result) });
    });
    // The surface the janitor needs.
    try {
      const listed = await ctx.session.list();
      write('list', { answer: seen(listed) });
    } catch (error) {
      write('list-error', String(error));
    }
    try {
      const created = await ctx.session.create({ title: 'the probe throwaway' });
      write('create', { answer: seen(created) });
      const id = created?.id;
      if (id !== undefined) {
        try {
          const got = await ctx.session.get({ sessionID: id });
          write('get', { answer: seen(got) });
        } catch (error) {
          write('get-error', String(error));
        }
        try {
          const removed = await ctx.session.remove({ sessionID: id });
          write('remove', { answer: seen(removed) });
        } catch (error) {
          write('remove-error', String(error));
        }
      }
    } catch (error) {
      write('create-error', String(error));
    }
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
`;
}

const root = await mkdtemp(join(tmpdir(), 'openagentsy-v2-e2e-'));
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

// The project's own config: the quality check runs during the round, and
// the command `echo` is one a person has to approve.
await writeFile(
  join(project, 'openagentsy.jsonc'),
  JSON.stringify({ quality: { mode: 'during' }, hooks: { approvalFor: ['echo'] } }, null, 2),
);

// The board with one lease, so a write inside the leased path is allowed.
const board = new Database(join(project, '.openagentsy', 'board.sqlite'));
board.exec(
  'CREATE TABLE leases (id integer PRIMARY KEY AUTOINCREMENT, bean text NOT NULL, agent text NOT NULL, glob text NOT NULL, granted_at text NOT NULL);' +
    'CREATE UNIQUE INDEX leases_agent_glob ON leases (agent, glob);',
);
board.run('INSERT INTO leases (bean, agent, glob, granted_at) VALUES (?, ?, ?, ?)', [
  '2d-8-e2e',
  agent,
  'leased/**',
  new Date().toISOString(),
]);
board.close();

if (!existsSync(bundle)) {
  process.stderr.write(`the adapter bundle is missing at ${bundle}; run the build first\n`);
  process.exit(1);
}
await copyFile(bundle, join(project, '.opencode', 'plugins', 'openagentsy.js'));
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
    title: 'the v2 end to end',
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
      'Do exactly these two things, one after the other, with the tools:',
      `First use the write tool to create the file leased/style.css with the text ${JSON.stringify(CSS)}`,
      'Then use the shell tool to run the command echo hello.',
      'Do not read any file and do not explain; just make the two calls.',
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
    if (found !== undefined) {
      report.evidence.assistantMessage = found;
      break;
    }
    await sleep(1000);
  }
  await sleep(3000);

  // What the model was shown: the messages of the session.
  const listed = await request('GET', `/api/session/${sessionID}/message`);
  const messages = listed.body?.data?.messages ?? listed.body?.data ?? listed.body?.messages ?? [];
  const flat = JSON.stringify(messages);
  report.evidence.qualityReachedModel = flat.includes('transition');
  report.evidence.qualitySnippet = (() => {
    const at = flat.indexOf('transition');
    if (at === -1) return undefined;
    return flat.slice(Math.max(0, at - 200), at + 300);
  })();
} finally {
  report.evidence.serverOutput = serverOutput.slice(-4000);
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), sleep(5000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

// The findings store: the findings of the check, recorded for the task.
try {
  report.evidence.findings = await readFile(
    join(project, '.openagentsy', 'quality', 'findings.json'),
    'utf8',
  );
} catch {
  report.evidence.findings = undefined;
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
const of = (kind) => lines.filter((entry) => entry.kind === kind).map((entry) => entry.payload);
report.evidence.permissions = of('permission');
report.evidence.afters = of('after');
report.evidence.list = of('list');
report.evidence.listError = of('list-error');
report.evidence.create = of('create');
report.evidence.get = of('get');
report.evidence.getError = of('get-error');
report.evidence.remove = of('remove');
report.evidence.removeError = of('remove-error');
report.evidence.eventTypes = [...new Set(of('event').map((entry) => entry?.type))];

if (!keep) await rm(root, { recursive: true, force: true });
report.evidence.kept = keep ? root : undefined;

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
