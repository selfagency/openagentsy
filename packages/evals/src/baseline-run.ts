import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatTotals, tokensFor, totalTokens } from './baseline.js';
import { prepare } from './fixture.js';
import { answerPermissions, runTurn, startHarness } from './opencode.js';

/**
 * The token baseline.
 *
 * The plan's exit test for phase 0: fewer tokens per resolved task than a
 * plain OpenCode session. The same task runs in a bare directory and in a
 * directory wired with the agents, the plugin and the board, and the tokens
 * of every session that belongs to the run are counted.
 *
 *   bun run baseline
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

const TASK =
  'Where does this repository decide that a write is allowed, and which file ' +
  'holds the rule that a fourth writer is refused? Name the files and the functions.';

/** A directory with the code under test and nothing else. */
async function seededDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'openagentsy-baseline-'));
  const { cp, copyFile } = await import('node:fs/promises');
  await cp(REPO_ROOT, join(root, 'packages'), {
    recursive: true,
    filter: (source) =>
      !source.includes('/node_modules') && !source.includes('/dist') && !source.includes('/.git'),
  });
  for (const file of ['roles.yaml', 'package.json', 'tsconfig.base.json', 'biome.jsonc']) {
    await copyFile(join(REPO_ROOT, file), join(root, file));
  }
  return root;
}

async function main(): Promise<void> {
  const model = process.env.OPENAGENTSY_EVAL_MODEL;
  const harness = await startHarness();
  // Both arms read the same code. The plain arm has no agents, no plugin and
  // no board; the agentsy arm has all of it.
  const plain = await seededDirectory();
  const agentsy = await seededDirectory();

  try {
    // The plain arm runs the default agent, in a directory with no agents and
    // no board. The agentsy arm runs the Lead, in a directory with all of it.
    const stopPlain = await answerPermissions(harness, plain);
    const plainTurn = await runTurn({
      harness,
      directory: plain,
      agent: 'build',
      ...(model !== undefined ? { model } : {}),
      text: TASK,
      timeoutMs: 900_000,
    });
    stopPlain();
    const plainTokens = await tokensFor(harness.client, plain, plainTurn.sessionID);

    await prepare(
      agentsy,
      { files: {}, leases: [{ agent: 'agentsy', glob: '**' }] },
      { repoRoot: REPO_ROOT },
    );
    const stopAgentsy = await answerPermissions(harness, agentsy);
    const agentsyTurn = await runTurn({
      harness,
      directory: agentsy,
      agent: 'agentsy',
      ...(model !== undefined ? { model } : {}),
      text: TASK,
      timeoutMs: 900_000,
    });
    stopAgentsy();
    const agentsyTokens = await tokensFor(harness.client, agentsy, agentsyTurn.sessionID);

    console.log(formatTotals('plain  ', plainTokens));
    console.log('');
    console.log(formatTotals('agentsy', agentsyTokens));
    console.log('');
    const plainTotal = totalTokens(plainTokens);
    const agentsyTotal = totalTokens(agentsyTokens);
    const delta = agentsyTotal - plainTotal;
    console.log(
      `agentsy used ${delta >= 0 ? '+' : ''}${delta} tokens against the plain session ` +
        `(${plainTotal === 0 ? 'n/a' : `${Math.round((delta / plainTotal) * 100)}%`}).`,
    );
    console.log('');
    console.log('plain reply:');
    console.log(plainTurn.text.slice(0, 600));
    console.log('');
    console.log('agentsy reply:');
    console.log(agentsyTurn.text.slice(0, 600));
  } finally {
    await harness.stop();
    await rm(plain, { recursive: true, force: true });
    await rm(agentsy, { recursive: true, force: true });
  }
}

await main();
