#!/usr/bin/env bun
import { Database } from 'bun:sqlite';
/**
 * The seven facts about a live OpenCode 2 server.
 *
 * The tree asserts seven things about OpenCode 2 that no unit test can prove,
 * because the unit tests use a context that supplies whatever the type says.
 * This script measures them on a live server: it starts one of its own, with
 * its own database and its own directory, drives one turn through it, and
 * prints a verdict per fact.
 *
 * The rules the measurement follows, and why:
 *
 *   - The server runs in the probe project, because the project is the
 *     location: the v2 API is location scoped, and the location is the
 *     directory the request names. The spelling differs per route, and the
 *     tree already knows it (packages/evals/src/v2client.ts): every call
 *     carries location[directory], and /api/session takes directory.
 *   - A project loads when a session is created in it, so the script creates
 *     one before it reads anything else.
 *   - The global configuration is moved aside, so the machine's own plugins
 *     and agents do not answer the probe.
 *   - The provider is called once. The turn that writes two files and runs
 *     one command answers the questions about the event, the agent and the
 *     message at the same time.
 *
 * It leaves nothing behind: the server is killed and the directory removed.
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
const bundle = join(here, '..', 'dist', 'index.js');
const rolesFile = join(here, '..', '..', '..', 'roles.yaml');

/** The binary under test. The machine has one on the PATH; a build can be named. */
const binary = process.argv[2] ?? process.env.OPENAGENTSY_PROBE_BIN ?? 'opencode';
const password = 'openagentsy-eval';
const model = { providerID: 'ollama-cloud', id: 'minimax-m3.1-flash' };
const agent = 'build';

/**
 * The event types of a stream, read until the stream ends.
 */
async function collectEventTypes(response, types) {
  const reader = response.body?.getReader();
  if (reader === undefined) return;
  let buffer = '';
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += String(chunk.value);
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const type = eventTypeOf(line);
      if (type !== undefined) types.push(type);
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The type of one server-sent event, when the line carries one.
 */
function eventTypeOf(line) {
  if (!line.startsWith('data:')) return undefined;
  try {
    const parsed = JSON.parse(line.slice(5).trim());
    return typeof parsed?.type === 'string' ? parsed.type : undefined;
  } catch {
    return undefined;
  }
}

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
  return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
}

/**
 * The probe plugin.
 *
 * It writes what the server hands it, raw, to a file: the permission event,
 * the context event and the event stream. The file is the evidence, and the
 * script reads it after the turn.
 */
function probePlugin(logFile) {
  return `import { appendFileSync } from 'node:fs';
const log = ${JSON.stringify(logFile)};
const write = (kind, payload) => {
  try {
    appendFileSync(log, JSON.stringify({ kind, payload }) + '\\n');
  } catch {}
};
export default {
  id: 'oa-v2-facts-probe',
  async setup(ctx) {
    write('domains', Object.keys(ctx).sort());
    for (const domain of Object.keys(ctx)) {
      write('shape', { domain, keys: Object.keys(ctx[domain] ?? {}).sort() });
    }
    const hook = async (name, register) => {
      try {
        await register();
        write('hook-ok', { name });
      } catch (error) {
        write('hook-error', { name, error: String(error) });
      }
    };
    await hook('permission.evaluate', () =>
      ctx.permission.hook('evaluate', async (event) => {
        write('permission', event);
      }),
    );
    await hook('session.context', () =>
      ctx.session.hook('context', async (event) => {
        write('context', event);
      }),
    );
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          write('event', { type: event.type, keys: Object.keys(event).sort() });
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

const root = await mkdtemp(join(tmpdir(), 'openagentsy-v2-facts-'));
const project = join(root, 'project');
const xdg = join(root, 'xdg');
const logFile = join(root, 'probe-events.jsonl');
await mkdir(join(project, '.opencode', 'plugins'), { recursive: true });
await mkdir(join(project, '.opencode', 'agents'), { recursive: true });
await mkdir(join(project, '.openagentsy'), { recursive: true });
await mkdir(xdg);

// The two probe agents, one for each spelling of the shell key. The read
// back is the answer to the question about the key: the resolved rules of an
// agent that asks for shell and of one that asks for bash.
const agentMarkdown = (name, action) => `---
description: the ${name} probe
mode: primary
permissions:
  - action: ${action}
    resource: "*"
    effect: allow
---

the ${name} probe
`;
await writeFile(
  join(project, '.opencode', 'agents', 'probe-shell.md'),
  agentMarkdown('shell', 'shell'),
);
await writeFile(
  join(project, '.opencode', 'agents', 'probe-bash.md'),
  agentMarkdown('bash', 'bash'),
);
await writeFile(
  join(project, 'opencode.json'),
  JSON.stringify(
    {
      $schema: 'https://opencode.ai/config.json',
      agent: {
        'probe-shell': {
          description: 'the shell probe',
          mode: 'primary',
          permissions: [{ action: 'shell', resource: '*', effect: 'allow' }],
        },
        'probe-bash': {
          description: 'the bash probe',
          mode: 'primary',
          permissions: [{ action: 'bash', resource: '*', effect: 'allow' }],
        },
      },
    },
    null,
    2,
  ),
);

// The roles file the guard reads, and the board the guard reads the leases
// from. One lease covers leased/ and names the agent of the session, so the
// write inside the leased path is allowed and the one outside is refused.
await copyFile(rolesFile, join(project, 'roles.yaml'));
const board = new Database(join(project, '.openagentsy', 'board.sqlite'));
board.exec(
  'CREATE TABLE leases (id integer PRIMARY KEY AUTOINCREMENT, bean text NOT NULL, agent text NOT NULL, glob text NOT NULL, granted_at text NOT NULL);' +
    'CREATE UNIQUE INDEX leases_agent_glob ON leases (agent, glob);',
);
board.run('INSERT INTO leases (bean, agent, glob, granted_at) VALUES (?, ?, ?, ?)', [
  '2c-15-probe',
  agent,
  'leased/**',
  new Date().toISOString(),
]);
board.close();

// The adapter itself, loaded by OpenCode the way a user would load it, so
// the write guard that answers the question is the one in the tree.
if (existsSync(bundle)) {
  await copyFile(bundle, join(project, '.opencode', 'plugins', 'openagentsy.js'));
} else {
  process.stderr.write(`the adapter bundle is missing at ${bundle}; run the build first\n`);
  process.exit(1);
}
await writeFile(join(project, '.opencode', 'plugins', 'probe.js'), probePlugin(logFile));

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const locationQuery = `location[directory]=${encodeURIComponent(project)}`;

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

const report = { questions: {}, evidence: {} };

try {
  // The server answers when it is up.
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

  // The version of the server under test, and whether the run command takes a
  // model flag. The help is read from the binary, not from the tree.
  const version = await new Promise((resolve) => {
    const out = spawn(binary, ['--version']);
    let text = '';
    out.stdout.on('data', (chunk) => {
      text += String(chunk);
    });
    out.on('close', () => resolve(text.trim()));
  });
  const runHelp = await new Promise((resolve) => {
    const out = spawn(binary, ['run', '--help']);
    let text = '';
    out.stdout.on('data', (chunk) => {
      text += String(chunk);
    });
    out.on('close', () => resolve(text));
  });
  report.evidence.version = version;
  report.evidence.runModelFlag = /--model/.test(runHelp);

  // The spec the server serves, for the questions the spec can answer.
  const spec = await request('GET', '/openapi.json');
  const schemas = spec.body?.components?.schemas ?? {};
  const assistant = schemas['Session.Message.Assistant']?.properties ?? {};
  report.evidence.specAssistantKeys = Object.keys(assistant).sort();
  report.evidence.specHasTokens = assistant.tokens !== undefined;
  report.evidence.specHasCost = assistant.cost !== undefined;
  report.evidence.specTimeKeys = Object.keys(assistant.time?.properties ?? {}).sort();

  // A session in the project loads the project.
  const created = await request('POST', '/api/session', {
    title: 'the v2 facts',
    location: { directory: project },
    agent,
    model,
  });
  const sessionID = created.body?.data?.id;
  report.evidence.sessionID = sessionID;
  if (sessionID === undefined) {
    throw new Error(`the server did not create a session: ${JSON.stringify(created.body)}`);
  }

  // The agents the project registered, with the rules they resolved to.
  const agentList = await request('GET', `/api/agent?${locationQuery}`);
  const agents = agentList.body?.data ?? [];
  report.evidence.agentIDs = agents.map((entry) => entry.id);
  report.evidence.probeAgents = agents
    .filter((entry) => String(entry.id).startsWith('probe'))
    .map((entry) => ({ id: entry.id, permissions: entry.permissions }));

  // The event stream, read while the turn runs.
  const eventTypes = [];
  const controller = new AbortController();
  const streamTask = (async () => {
    try {
      const response = await fetch(`${base}/api/event?${locationQuery}`, {
        headers: { Authorization: authorization(), Accept: 'text/event-stream' },
        signal: controller.signal,
      });
      await collectEventTypes(response, eventTypes);
    } catch {
      /* the stream ends with the turn */
    }
  })();

  // One turn: it writes a file inside the leased path, a file outside it, and
  // it runs a shell command. The three calls answer the questions about the
  // permission event, the agent and the message in one provider call.
  await request('POST', `/api/session/${sessionID}/agent`, { agent });
  await request('POST', `/api/session/${sessionID}/model`, { model });
  await request('POST', `/api/session/${sessionID}/prompt`, {
    text: [
      'Do exactly these three things, one after the other, with the tools:',
      'First use the write tool to create the file leased/ok.txt with the text ok.',
      'Then use the write tool to create the file unleased/no.txt with the text no.',
      'Then use the shell tool to run the command echo hello.',
      'Do not read any file and do not explain; just make the three calls.',
    ].join(' '),
    agents: [{ name: agent }],
  });

  // The turn is over when the assistant message carries a completed time.
  let assistantMessage;
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const listed = await request('GET', `/api/session/${sessionID}/message`);
    const messages =
      listed.body?.data?.messages ?? listed.body?.data ?? listed.body?.messages ?? [];
    const found = messages.find(
      (message) => message?.type === 'assistant' && message?.time?.completed !== undefined,
    );
    if (found !== undefined) {
      assistantMessage = found;
      break;
    }
    await sleep(1000);
  }
  // The events at the end of the turn arrive after the message.
  await sleep(5000);
  controller.abort();
  await streamTask;

  report.evidence.eventTypes = eventTypes;
  report.evidence.assistantMessage =
    assistantMessage === undefined
      ? undefined
      : {
          agent: assistantMessage.agent,
          model: assistantMessage.model,
          tokens: assistantMessage.tokens,
          cost: assistantMessage.cost,
          time: assistantMessage.time,
        };

  // What the plugin saw.
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
  report.evidence.probeLines = lines.length;
  // The plugin's own subscription, which is the one the adapter reads.
  report.evidence.pluginEventTypes = lines
    .filter((entry) => entry.kind === 'event')
    .map((entry) => entry.payload?.type)
    .filter((type) => typeof type === 'string');
  report.evidence.permissionEvents = lines
    .filter((entry) => entry.kind === 'permission')
    .map((entry) => entry.payload);
  report.evidence.contextEvents = lines
    .filter((entry) => entry.kind === 'context')
    .map((entry) => entry.payload);
  report.evidence.hookResults = lines
    .filter((entry) => entry.kind === 'hook-ok' || entry.kind === 'hook-error')
    .map((entry) => entry);
  report.evidence.domains = lines.find((entry) => entry.kind === 'domains')?.payload;

  // The guard's own record of what it decided.
  let audit = '';
  try {
    audit = await readFile(join(project, '.openagentsy', 'audit.jsonl'), 'utf8');
  } catch {
    /* the guard never wrote */
  }
  report.evidence.audit = audit
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
} finally {
  report.evidence.serverOutput = serverOutput.slice(-4000);
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), sleep(5000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await rm(root, { recursive: true, force: true });
}

// The verdicts, one per question.
const permissionEvents = report.evidence.permissionEvents ?? [];
const withAgent = permissionEvents.filter((event) => event?.agent !== undefined);
const shellEvent = permissionEvents.find((event) =>
  ['bash', 'shell'].includes(String(event?.action)),
);
const writeEvents = permissionEvents.filter((event) => String(event?.action) === 'edit');

report.questions['1 write lockout'] = {
  measured: permissionEvents.length > 0,
  answer:
    permissionEvents.length === 0
      ? 'not measurable here: no permission event was seen'
      : withAgent.length === permissionEvents.length
        ? 'the event carries agent, so the guard is not a total lockout'
        : 'the event does not always carry agent',
  evidence: {
    events: permissionEvents.map((event) => ({
      action: event?.action,
      agent: event?.agent,
      effect: event?.effect,
      resources: event?.resources,
    })),
    writes: writeEvents.map((event) => ({ resources: event?.resources, effect: event?.effect })),
  },
};
report.questions['2 context hook'] = {
  measured: (report.evidence.contextEvents ?? []).length > 0,
  answer:
    (report.evidence.contextEvents ?? []).length > 0
      ? 'the context hook fired'
      : 'the context hook did not fire in this turn',
  evidence: {
    hook: report.evidence.hookResults,
    contexts: report.evidence.contextEvents,
  },
};
report.questions['3 shell key'] = {
  measured: shellEvent !== undefined,
  answer:
    shellEvent === undefined
      ? 'not measurable here: no shell tool call was seen'
      : `the server calls the shell tool ${String(shellEvent.action)}`,
  evidence: { shell: shellEvent, probeAgents: report.evidence.probeAgents },
};
report.questions['4 turn end event'] = {
  measured: (report.evidence.pluginEventTypes ?? []).length > 0,
  answer: `the turn ended with ${(report.evidence.pluginEventTypes ?? []).slice(-8).join(', ')}`,
  evidence: {
    pluginEvents: report.evidence.pluginEventTypes,
    restEvents: report.evidence.eventTypes,
  },
};
report.questions['5 run model flag'] = {
  measured: report.evidence.runModelFlag === true,
  answer: report.evidence.runModelFlag === true ? 'the flag exists' : 'the flag does not exist',
  evidence: { version: report.evidence.version },
};
report.questions['6 tokens and cost'] = {
  measured: report.evidence.assistantMessage?.tokens !== undefined,
  answer:
    report.evidence.assistantMessage === undefined
      ? 'not measurable here: the turn produced no assistant message'
      : 'the assistant message carries tokens and cost',
  evidence: {
    spec: {
      hasTokens: report.evidence.specHasTokens,
      hasCost: report.evidence.specHasCost,
    },
    live: report.evidence.assistantMessage,
  },
};
report.questions['7 message time'] = {
  measured: report.evidence.assistantMessage?.time !== undefined,
  answer:
    report.evidence.assistantMessage === undefined
      ? 'not measurable here: the turn produced no assistant message'
      : 'the assistant message carries time',
  evidence: {
    spec: report.evidence.specTimeKeys,
    live: report.evidence.assistantMessage?.time,
  },
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
