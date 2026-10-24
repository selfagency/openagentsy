#!/usr/bin/env node
/**
 * The OpenCode 2 conformance probe.
 *
 * The suite drives a real server through the V1 client, and the V2 server
 * has a different API, so the suite cannot run there yet. What this probe
 * does check is the thing that breaks first when the V2 API moves: that the
 * plugin loads in a real V2, that the adapter's setup runs against a real V2
 * context, and that the context still has the domains the adapter uses.
 *
 * It writes a marker file and exits non-zero when the setup fails, so it can
 * be a CI step.
 */
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bundle = join(here, '..', 'dist', 'index.js');

const root = await mkdtemp(join('/tmp', 'openagentsy-v2-probe-'));
const plugins = join(root, '.opencode', 'plugins');
const marker = join(root, 'probe.json');

await mkdir(plugins, { recursive: true });

// The adapter itself, loaded by OpenCode the way a user would load it.
await copyFile(bundle, join(plugins, 'openagentsy.js'));

// The probe. It calls the adapter's setup with the real context, and records
// what happened.
await writeFile(
  join(plugins, 'probe.js'),
  `import { writeFileSync } from 'node:fs';
import adapter from ${JSON.stringify(bundle)};

export default {
  id: 'openagentsy-probe',
  async setup(ctx) {
    let ok = true;
    let error = '';
    try {
      await adapter.setup(ctx);
    } catch (cause) {
      ok = false;
      error = String(cause && cause.stack ? cause.stack : cause);
    }
    writeFileSync(
      ${JSON.stringify(marker)},
      JSON.stringify({ ok, error, domains: Object.keys(ctx).sort() }, null, 2),
    );
    return () => {};
  },
  async server() {
    return {};
  },
};
`,
);

// The plugin loads when a session starts, not when the server listens, so
// the probe starts a session. The model it cannot reach does not matter: the
// marker is written during the plugin setup, before any model call.

const logFile = process.env.PROBE_LOG;
const logFd = logFile === undefined ? 'ignore' : openSync(logFile, 'a');
// The v2's run command reads OPENCODE_SERVER_PASSWORD and takes a different
// startup path when it is set, so the probe deletes it. The plugin runs in
// the process, so it needs no password.
// The binary under test. CI pins it on the PATH; a local run can point
// OPENCODE_BIN at a specific build.
const bin = process.env.OPENCODE_BIN ?? 'opencode';
const env = { ...process.env };
delete env.OPENCODE_SERVER_PASSWORD;
// The probe gets its own database. OpenCode 2 migrates the database to its
// own schema, and the two schemas are not compatible, so a probe that opens
// the caller's database leaves their OpenCode 1 unable to read it. The
// database lives beside the probe's other files, so the whole run is
// disposable.
env.OPENCODE_DB = join(root, 'probe.db');
// The v2's run starts a background service, and the service takes its project
// directory from the process that starts it. Spawned directly from node, the
// service boots in the wrong directory and the project's plugins never load.
// Going through a shell hands the cwd over correctly.
const child = spawn(
  '/bin/sh',
  ['-c', `cd ${JSON.stringify(root)} && exec ${JSON.stringify(bin)} run hi`],
  {
    stdio: ['ignore', logFd, logFd],
    env,
    detached: true,
  },
);

async function readMarker() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      return JSON.parse(await readFile(marker, 'utf8'));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  return undefined;
}

try {
  const result = await readMarker();
  if (result === undefined) {
    process.stderr.write('the probe did not run: the plugin never loaded\n');
    process.exitCode = 1;
  } else if (result.ok !== true) {
    process.stderr.write(`the adapter's setup failed in OpenCode 2:\n${result.error}\n`);
    process.exitCode = 1;
  } else {
    const missing = ['session', 'tool', 'permission', 'event'].filter(
      (domain) => !result.domains.includes(domain),
    );
    if (missing.length > 0) {
      process.stderr.write(`the context is missing: ${missing.join(', ')}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write('the adapter loads in OpenCode 2 and its setup registers\n');
    }
  }
} finally {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}
