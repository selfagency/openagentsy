#!/usr/bin/env bun
/**
 * Whether the shell of an agent can be given a tightened environment on OpenCode 2.
 *
 * The V1 path had a `shell.env` hook: it filled an object and the shell read
 * it, so the policy could remove a key before the command ran. The V2 shell
 * domain takes a hook, and the name that fires is `create.before`, with the
 * environment of the child in it. This script measures whether the mutation
 * reaches the child process.
 *
 * The measurement is a canary. The server runs with a marker in its
 * environment, the agent runs one command that dumps the environment of the
 * child, and the script reads the answer from the tool result. The plugin
 * records the environment it was handed before the mutation, so the run is
 * its own control: the marker is in the environment the server built, and the
 * question is whether it is in the environment the child got.
 *
 * It leaves nothing behind: the server is killed and the directory removed.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rolesFile = join(here, '..', '..', '..', 'roles.yaml');

/** The binary under test. The machine has one on the PATH; a build can be named. */
const binary = process.argv[2] ?? process.env.OPENAGENTSY_PROBE_BIN ?? 'opencode';
const password = 'openagentsy-eval';
const model = { providerID: 'ollama-cloud', id: 'minimax-m3.1-flash' };
const agent = 'build';

/** The key the server is started with, and the value that must not survive. */
const CANARY_KEY = 'OA_PROBE_SECRET';
const CANARY_VALUE = 'canary-value';

/** The keys the policy removes, so the run shows what an agent's shell loses. */
const POLICY_KEYS = ['OA_PROBE_SECRET', 'HUSKY', 'HUSKY_SKIP_HOOKS', 'SKIP_SIMPLE_GIT_HOOKS'];

/**
 * The probe plugin.
 *
 * It writes what the server hands it, raw, to a file: the environment the
 * shell was about to run with, the environment after the mutation, the
 * permission event of the shell call, and the result of the call.
 */
function probePlugin(logFile) {
  return `import { appendFileSync } from 'node:fs';
const log = ${JSON.stringify(logFile)};
const write = (kind, payload) => {
  try {
    appendFileSync(log, JSON.stringify({ kind, payload }) + '\\n');
  } catch {}
};
const KEYS = ${JSON.stringify(POLICY_KEYS)};
export default {
  id: 'oa-v2-shell-env-probe',
  async setup(ctx) {
    // The shell domain. The hook fires before the child is spawned, with the
    // environment the child would get.
    try {
      await ctx.shell.hook('create.before', async (event) => {
        write('shell-before', {
          command: event?.command,
          cwd: event?.cwd,
          shell: event?.shell,
          envKeys: Object.keys(event?.env ?? {}).sort(),
          present: Object.fromEntries(KEYS.map((key) => [key, event?.env?.[key] !== undefined])),
        });
        for (const key of KEYS) delete event.env[key];
        write('shell-after', {
          present: Object.fromEntries(KEYS.map((key) => [key, event?.env?.[key] !== undefined])),
        });
      });
      write('hook-ok', { name: 'shell.create.before' });
    } catch (error) {
      write('hook-error', { name: 'shell.create.before', error: String(error) });
    }
    // The permission event of the shell call: the resource the server shows.
    try {
      await ctx.permission.hook('evaluate', async (event) => {
        if (event?.action !== 'shell' && event?.action !== 'bash') return;
        write('permission', { action: event.action, resources: event.resources, effect: event.effect });
      });
    } catch (error) {
      write('hook-error', { name: 'permission.evaluate', error: String(error) });
    }
    // The result of the shell call: what the child printed.
    try {
      await ctx.tool.hook('execute.after', async (event) => {
        write('tool-after', {
          tool: event?.tool,
          status: event?.status,
          result: event?.result,
          error: event?.error,
        });
      });
    } catch (error) {
      write('hook-error', { name: 'tool.execute.after', error: String(error) });
    }
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type === 'session.idle' || event.type === 'session.execution.succeeded') {
            write('turn-end', { type: event.type });
          }
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

const root = await mkdtemp(join(tmpdir(), 'openagentsy-v2-shell-env-'));
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
// The roles file the adapter reads, so the plugin of the tree runs the way it
// runs in a project.
await copyFile(rolesFile, join(project, 'roles.yaml'));
await writeFile(join(project, '.opencode', 'plugins', 'probe.js'), probePlugin(logFile));

// A plugin of the tree, loaded beside the probe, when the run measures the
// adapter rather than the surface.
const extraPlugin = process.env.OA_PROBE_PLUGIN;
if (extraPlugin !== undefined && extraPlugin !== '') {
  await copyFile(extraPlugin, join(project, '.opencode', 'plugins', 'extra.js'));
}

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
    // The canary. It is in the environment of the server, so it is in the
    // environment the server hands to the shell of the agent.
    [CANARY_KEY]: CANARY_VALUE,
    HUSKY: '0',
    HUSKY_SKIP_HOOKS: '1',
    SKIP_SIMPLE_GIT_HOOKS: '1',
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

const report = { questions: {}, evidence: {} };

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

  const version = await new Promise((resolve) => {
    const out = spawn(binary, ['--version']);
    let text = '';
    out.stdout.on('data', (chunk) => {
      text += String(chunk);
    });
    out.on('close', () => resolve(text.trim()));
  });
  report.evidence.version = version;

  const created = await request('POST', '/api/session', {
    title: 'the v2 shell env',
    location: { directory: project },
    agent,
    model,
  });
  const sessionID = created.body?.data?.id;
  report.evidence.sessionID = sessionID;
  if (sessionID === undefined) {
    throw new Error(`the server did not create a session: ${JSON.stringify(created.body)}`);
  }

  await request('POST', `/api/session/${sessionID}/agent`, { agent });
  await request('POST', `/api/session/${sessionID}/model`, { model });
  await request('POST', `/api/session/${sessionID}/prompt`, {
    text: [
      'Use the shell tool exactly once, with this command and nothing else:',
      'env',
      'Do not read any file, do not run any other command, and do not explain.',
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
  await sleep(3000);
  report.evidence.assistantMessage =
    assistantMessage === undefined ? undefined : { agent: assistantMessage.agent };
} finally {
  report.evidence.serverOutput = serverOutput.slice(-4000);
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), sleep(5000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  const keep = process.env.OA_PROBE_KEEP === '1';
  if (!keep) await rm(root, { recursive: true, force: true });
  report.evidence.kept = keep ? root : undefined;
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

const before = lines.find((entry) => entry.kind === 'shell-before')?.payload;
const after = lines.find((entry) => entry.kind === 'shell-after')?.payload;
const permission = lines.find((entry) => entry.kind === 'permission')?.payload;
const toolAfter = lines.find((entry) => entry.kind === 'tool-after')?.payload;

// The output of the child is in the result of the tool call. The shape of the
// result is the server's, so every string under it is searched.
const printed = JSON.stringify(toolAfter ?? {});
const childSawCanary = printed.includes(CANARY_VALUE);
const childSawOpenAgentsy = printed.includes('OPENAGENTSY_AGENT');

report.questions['does the shell hook fire'] = {
  measured: before !== undefined,
  answer:
    before === undefined
      ? 'the create.before hook of the shell domain did not fire'
      : 'the create.before hook fired and carried the environment of the child',
  evidence: { before, after },
};
report.questions['does the child see the tightened environment'] = {
  measured: before !== undefined && !childSawCanary,
  answer:
    before === undefined
      ? 'not measurable: the hook never fired'
      : childSawCanary
        ? 'the child still saw the canary: the mutation did not reach the child'
        : 'the child did not see the canary: the mutation reached the child',
  evidence: {
    canaryInTheEnvironmentTheServerBuilt: before?.present,
    canaryInTheEnvironmentAfterTheMutation: after?.present,
    canaryInTheOutputOfTheChild: childSawCanary,
    openagentsyMarkerInTheOutputOfTheChild: childSawOpenAgentsy,
  },
};
report.questions['does the permission event still carry the original command'] = {
  measured: permission !== undefined,
  answer:
    permission === undefined
      ? 'no shell permission event was seen'
      : `the resource of the shell permission event is ${JSON.stringify(permission.resources)}`,
  evidence: { permission, commandSeenByTheHook: before?.command },
};
report.questions['what the plugin recorded'] = {
  measured: lines.length > 0,
  answer: `${lines.length} lines`,
  evidence: {
    hookResults: lines
      .filter((entry) => entry.kind === 'hook-ok' || entry.kind === 'hook-error')
      .map((entry) => entry.payload),
    toolName: toolAfter?.tool,
  },
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
