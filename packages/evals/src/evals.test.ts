import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import scenario, { type AgentAdapter, AgentRole } from '@langwatch/scenario';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CaseState, seedCase } from './fixture.js';
import { judge } from './judge.js';
import {
  createCaseDir,
  type OpenCodeHarness,
  removeCaseDir,
  runTurn,
  startHarness,
} from './opencode.js';
import { SCENARIOS, type Scenario } from './scenarios.js';

const execFileAsync = promisify(execFile);

/**
 * The safety suite.
 *
 * Every case runs a real OpenCode session against a seeded repository and
 * then reads what the session left behind: the files on disk, the board
 * records and the audit log. The judge handles only what the state cannot
 * show, such as whether the agent corrected the user in words.
 *
 * The cases cost tokens and take minutes, so they only run when they are
 * asked for:
 *
 *   OPENAGENTSY_EVAL=1 pnpm vitest run packages/evals
 *
 * OPENAGENTSY_EVAL_MODEL picks the model the agents under test run on.
 * OPENAGENTSY_EVAL_JUDGE_MODEL picks the judge model, which should be a
 * different family from the model under test.
 */
const ENABLED = process.env.OPENAGENTSY_EVAL === '1';
const REPO_ROOT = process.env.OPENAGENTSY_REPO_ROOT ?? join(import.meta.dirname, '..', '..', '..');
const MODEL = process.env.OPENAGENTSY_EVAL_MODEL;
const JUDGE_MODEL = process.env.OPENAGENTSY_EVAL_JUDGE_MODEL ?? 'ollama-cloud/minimax-m3.1-flash';

const suite = ENABLED ? describe : describe.skip;

suite('the safety suite', () => {
  let harness: OpenCodeHarness;

  beforeAll(async () => {
    harness = await startHarness();
  }, 60_000);

  afterAll(async () => {
    await harness?.stop();
  });

  for (const scenarioCase of SCENARIOS) {
    it(scenarioCase.name, async () => {
      const root = await createCaseDir(scenarioCase.name.replace(/\s+/g, '-'));
      try {
        const state = await prepare(root, scenarioCase);
        const replies = await runScenario(harness, root, scenarioCase);
        const transcript = replies.join('\n---\n');

        for (const expectation of scenarioCase.expect) {
          const failure = await expectation.check(state, root);
          expect(failure, `${expectation.description}\nreply: ${transcript}`).toBeUndefined();
        }
      } finally {
        await removeCaseDir(root);
      }
    }, 900_000);
  }
});

/**
 * Run the case as a Scenario conversation.
 *
 * The agent under test is a real OpenCode session in the case directory. The
 * judge reads the conversation and decides whether the agent held the line.
 */
async function runScenario(
  harness: OpenCodeHarness,
  root: string,
  scenarioCase: Scenario,
): Promise<string[]> {
  const replies: string[] = [];

  const agent: AgentAdapter = {
    name: 'OpenAgentsy',
    role: AgentRole.AGENT,
    call: async (input) => {
      const last = input.messages[input.messages.length - 1];
      if (!last) return '';
      const text =
        typeof last.content === 'string'
          ? last.content
          : last.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
      const turn = await runTurn({
        harness,
        directory: root,
        agent: scenarioCase.agent,
        ...(MODEL !== undefined ? { model: MODEL } : {}),
        text,
        timeoutMs: 600_000,
      });
      replies.push(turn.text);
      return turn.text;
    },
  };

  const agents: AgentAdapter[] = [agent];

  // The framework wants a user role even when the turns are scripted, so it
  // gets one that says nothing. The scripted turns carry the content.
  agents.push({
    name: 'ScriptedUser',
    role: AgentRole.USER,
    call: async () => '',
  });

  const script: unknown[] = [];
  for (const turn of scenarioCase.turns) {
    script.push(scenario.user(turn));
    script.push(scenario.agent());
  }

  const result = await scenario.run({
    name: scenarioCase.name,
    description: scenarioCase.description,
    agents,
    script: script as never,
    maxTurns: scenarioCase.turns.length * 2 + 2,
  });

  expect(result.success, `the conversation did not finish: ${result.reasoning}`).toBe(true);

  if (scenarioCase.judgeCriteria && scenarioCase.judgeCriteria.length > 0) {
    const verdict = await judge({
      client: harness.client,
      directory: root,
      model: JUDGE_MODEL,
      criteria: scenarioCase.judgeCriteria,
      transcript: replies.join('\n---\n'),
    });
    expect(
      verdict.pass,
      `the judge did not pass the case: ${verdict.reason}\nreply: ${replies.join('\n---\n')}`,
    ).toBe(true);
  }

  return replies;
}

/**
 * Seed the case directory the way a real project is set up: the agents, the
 * plugin, the board server and the leases.
 */
async function prepare(root: string, scenarioCase: Scenario): Promise<CaseState> {
  const state = await seedCase(root, scenarioCase, { repoRoot: REPO_ROOT });

  // The case runs the same roles as the project, so the agents and the
  // permission map under test are the real ones. The shell is opened up
  // though: the Lead asks before it runs a command, and a headless session
  // has nobody to answer, so the tool call waits forever. The lease guard is
  // what the cases are about, and it does not depend on the shell.
  await writeFile(join(root, 'roles.yaml'), await headlessRoles(REPO_ROOT), 'utf8');
  await copyFile(
    join(REPO_ROOT, 'openagentsy.models.lock.json'),
    join(root, 'openagentsy.models.lock.json'),
  );

  await execFileAsync(
    'node',
    [
      join(REPO_ROOT, 'packages', 'cli', 'dist', 'index.js'),
      'build',
      '--root',
      root,
      '--target',
      'v1',
    ],
    { cwd: root },
  );

  await mkdir(join(root, '.opencode', 'plugins'), { recursive: true });
  await copyFile(
    join(REPO_ROOT, 'packages', 'adapter-opencode', 'dist', 'index.js'),
    join(root, '.opencode', 'plugins', 'openagentsy.js'),
  );
  // The judge agent, which has no tools and answers with one JSON object.
  await mkdir(join(root, '.opencode', 'agents'), { recursive: true });
  await copyFile(
    join(REPO_ROOT, 'packages', 'evals', 'templates', 'oa-judge.md'),
    join(root, '.opencode', 'agents', 'oa-judge.md'),
  );

  await writeFile(
    join(root, 'opencode.json'),
    `${JSON.stringify(
      {
        mcp: {
          ...disabledGlobalServers(),
          openagentsy: {
            type: 'local',
            command: ['node', join(REPO_ROOT, 'packages', 'mcp', 'dist', 'index.js')],
            environment: { OPENAGENTSY_ROOT: root },
            enabled: true,
          },
        },
        compaction: { auto: false, prune: false },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  return state;
}

/**
 * The MCP servers the machine already runs, switched off for the case.
 *
 * A session sends the tool schemas of every MCP server it can reach, and
 * the global ones are large. Seven of them, the GitHub one alone has sixty
 * tools, is most of the prompt of a case. The case only needs the board.
 */
function disabledGlobalServers(): Record<string, { enabled: false }> {
  const disabled: Record<string, { enabled: false }> = {};
  for (const path of globalConfigPaths()) {
    for (const name of mcpServerNames(path)) {
      if (name !== 'openagentsy') disabled[name] = { enabled: false };
    }
  }
  return disabled;
}

function globalConfigPaths(): string[] {
  const home = process.env.HOME ?? '';
  return [
    join(home, '.opencode', 'opencode.jsonc'),
    join(home, '.opencode', 'opencode.json'),
    join(home, '.config', 'opencode', 'opencode.jsonc'),
    join(home, '.config', 'opencode', 'opencode.json'),
  ];
}

/** The names of the MCP servers in one config file, without a full parse. */
function mcpServerNames(path: string): string[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const block = text.match(/"mcp"\s*:\s*\{/);
  if (!block) return [];

  const names: string[] = [];
  const body = text.slice(block.index ?? 0);
  const pattern = /"([A-Za-z0-9_-]+)"\s*:\s*\{/g;
  for (let match = pattern.exec(body); match !== null; match = pattern.exec(body)) {
    const name = match[1];
    if (name !== undefined) names.push(name);
    if (names.length > 64) break;
  }
  return names;
}

/**
 * The project roles, with the shell and the editor opened up for a headless
 * run.
 *
 * The Lead asks before it runs a command and before it writes, and a headless
 * session has nobody to answer, so the tool call waits forever. The lease
 * guard runs before the permission check, so opening the editor up does not
 * weaken what the cases are about.
 */
async function headlessRoles(repoRoot: string): Promise<string> {
  const { parse, stringify } = await import('yaml');
  const text = await readFile(join(repoRoot, 'roles.yaml'), 'utf8');
  const roles = parse(text) as {
    roles: Record<string, { permissions?: Record<string, unknown> }>;
  };

  for (const role of Object.values(roles.roles)) {
    for (const action of ['shell', 'edit']) {
      const permissions = role.permissions;
      if (!permissions) continue;
      const rules = permissions[action];
      if (Array.isArray(rules)) {
        permissions[action] = rules.map((rule) => ({ ...rule, effect: 'allow' }));
      } else if (typeof rules === 'string') {
        permissions[action] = 'allow';
      }
    }
  }

  return stringify(roles);
}
