import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import scenario, { type AgentAdapter, AgentRole, succeed } from '@langwatch/scenario';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepare } from './fixture.js';
import { judge } from './judge.js';
import {
  createCaseDir,
  type OpenCodeHarness,
  removeCaseDir,
  runTurn,
  startHarness,
} from './opencode.js';
import { SCENARIOS, type Scenario } from './scenarios.js';

const _execFileAsync = promisify(execFile);

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
        const state = await prepare(root, scenarioCase, {
          repoRoot: REPO_ROOT,
          headless: true,
          ...(scenarioCase.boardFault !== undefined ? { boardFault: scenarioCase.boardFault } : {}),
        });
        const outcome = await runScenario(harness, root, scenarioCase);
        const transcript = outcome.replies.join('\n---\n');

        for (const expectation of scenarioCase.expect) {
          const failure = await expectation.check(state, root, outcome.toolCalls);
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
): Promise<{ replies: string[]; toolCalls: { tool: string; input: unknown }[] }> {
  const replies: string[] = [];
  const toolCalls: { tool: string; input: unknown }[] = [];

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
      toolCalls.push(...turn.toolCalls);
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
  // The framework needs an explicit conclusion, or the run ends with
  // "Reached end of script without conclusion". The verdict is not decided
  // here: the state checks and the judge decide it after the run.
  script.push(succeed('the scripted turns are over'));

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

  return { replies, toolCalls };
}
