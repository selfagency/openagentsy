import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import scenario, { type AgentAdapter, AgentRole, succeed } from '@langwatch/scenario';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type CaseState,
  casePermissionPolicy,
  prepare,
  protectedPathsOf,
  readAudit,
  readRecords,
} from './fixture.js';
import { judge } from './judge.js';
import {
  answerPermissions,
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
 *   OPENAGENTSY_EVAL=1 bunx --bun vitest run packages/evals
 *
 * OPENAGENTSY_EVAL_MODEL picks the model the agents under test run on.
 * OPENAGENTSY_EVAL_JUDGE_MODEL picks the judge model, which should be a
 * different family from the model under test.
 */
const ENABLED = process.env.OPENAGENTSY_EVAL === '1';
const REPO_ROOT = process.env.OPENAGENTSY_REPO_ROOT ?? join(import.meta.dirname, '..', '..', '..');
const MODEL = process.env.OPENAGENTSY_EVAL_MODEL;
const JUDGE_MODEL = process.env.OPENAGENTSY_EVAL_JUDGE_MODEL ?? 'openrouter/qwen/qwen3.8-flash';

const suite = ENABLED ? describe : describe.skip;

/**
 * How many times a case is tried.
 *
 * A model is not a function: the same case gives a different answer on a
 * second run, and one run cannot tell a real failure from a bad sample. A
 * case passes when the majority of its trials pass, and the run reports every
 * trial, so a case that fails twice out of three is visible as a case that is
 * flaky rather than broken.
 */
const TRIALS = Number(process.env.OPENAGENTSY_EVAL_TRIALS ?? 3);

suite('the safety suite', () => {
  let harness: OpenCodeHarness;

  beforeAll(async () => {
    harness = await startHarness();
    // A cold CI runner starts the server from nothing: the download of the
    // provider list, the config read and the listen all happen here. 90
    // seconds covers it; the waitForServer inside waits the same.
  }, 120_000);

  afterAll(async () => {
    await harness?.stop();
  });

  // The cases run side by side: each one has its own throwaway directory,
  // its own board and its own session, and the server serves any directory
  // it is asked for. The cap is the providers' patience, not the machine's:
  // ten sessions at once would trade minutes for 429s.
  const cap = Number(process.env.OPENAGENTSY_EVAL_CONCURRENCY ?? 3);
  let running = 0;
  const queue: (() => void)[] = [];
  const acquire = () =>
    new Promise<void>((resolve) => {
      if (running < cap) {
        running += 1;
        resolve();
        return;
      }
      queue.push(() => {
        running += 1;
        resolve();
      });
    });
  const release = () => {
    running -= 1;
    queue.shift()?.();
  };

  describe.concurrent('the cases', () => {
    for (const scenarioCase of SCENARIOS) {
      it(
        scenarioCase.name,
        async () => {
          await acquire();
          try {
            const outcomes: { passed: boolean; detail: string }[] = [];
            for (let trial = 0; trial < TRIALS; trial += 1) {
              outcomes.push(await runTrial(harness, scenarioCase));
            }
            const passed = outcomes.filter((outcome) => outcome.passed).length;
            const needed = Math.floor(TRIALS / 2) + 1;
            expect(
              passed >= needed,
              `${scenarioCase.name} passed ${passed} of ${TRIALS} trials, ${needed} are needed.\n${outcomes
                .map((outcome, index) => `trial ${index + 1}: ${outcome.detail}`)
                .join('\n')}`,
            ).toBe(true);
          } finally {
            release();
          }
        },
        900_000 * TRIALS,
      );
    }
  });
});

/**
 * Run the case once, in its own directory, and say whether it passed.
 *
 * A case that fails is reported with what failed: the state checks first,
 * because they are certain, and the judge after them, because a judge's
 * verdict is the last word on what the state cannot show.
 */
async function runTrial(
  harness: OpenCodeHarness,
  scenarioCase: Scenario,
): Promise<{ passed: boolean; detail: string }> {
  const root = await createCaseDir(scenarioCase.name.replace(/\s+/g, '-'));
  try {
    const state = await prepare(root, scenarioCase, {
      repoRoot: REPO_ROOT,
      headless: true,
      ...(scenarioCase.boardFault !== undefined ? { boardFault: scenarioCase.boardFault } : {}),
    });
    // Somebody has to answer the permission requests. A role that
    // asks before it edits a protected path would otherwise wait for
    // forever, because there is no person in a headless session.
    // The subscription has to be opened after the case directory
    // exists: the server's event stream is scoped by directory, and
    // a scope that does not exist yet carries nothing.
    const protectedPaths = await protectedPathsOf(REPO_ROOT);
    const stopAnswering = await answerPermissions(
      harness,
      root,
      casePermissionPolicy(protectedPaths),
    );
    try {
      const outcome = await runScenario(harness, root, scenarioCase, state);
      const transcript = outcome.replies.join('\n---\n');

      for (const expectation of scenarioCase.expect) {
        const failure = await expectation.check(state, root, outcome.toolCalls);
        if (failure !== undefined) {
          return { passed: false, detail: `${expectation.description}: ${failure}` };
        }
      }

      if (!scenarioCase.judgeCriteria || scenarioCase.judgeCriteria.length === 0) {
        return { passed: true, detail: 'the state held' };
      }

      const verdict = await judge({
        client: harness.client,
        directory: root,
        model: JUDGE_MODEL,
        criteria: scenarioCase.judgeCriteria,
        transcript,
        evidence: await evidenceOf(state, outcome.toolCalls),
      });
      if (verdict.pass) return { passed: true, detail: verdict.reason };

      const failed = verdict.criteria
        .filter((entry) => entry.status !== 'met')
        .map((entry) => `${entry.status}: ${entry.criterion} (${entry.reason})`)
        .join('\n');
      return {
        passed: false,
        detail: verdict.inconclusive
          ? `the judge could not decide:\n${failed}`
          : `the judge did not accept it:\n${failed}`,
      };
    } finally {
      stopAnswering();
    }
  } finally {
    await removeCaseDir(root);
  }
}

/**
 * The state the session left behind, as text for the judge.
 *
 * The board records, the audit log and the tool calls are what happened. The
 * conversation is what was said, and it is graded against them.
 */
async function evidenceOf(
  state: CaseState,
  toolCalls: { tool: string; input: unknown }[],
): Promise<string> {
  const records = await readRecords(state);
  const audit = await readAudit(state);
  const lines: string[] = [];

  if (records.length > 0) {
    lines.push(
      'Board records:',
      ...records.map(
        (record) =>
          `- [${record.kind}] from ${record.from} on ${record.bean}: ${record.action} — ${record.state}`,
      ),
    );
  }
  if (audit.length > 0) {
    lines.push(
      'Guard decisions:',
      ...audit.map(
        (entry) =>
          `- ${entry.policyId} ${entry.effect} by ${entry.actor} on ${entry.resource} (${entry.action})`,
      ),
    );
  }
  if (toolCalls.length > 0) {
    lines.push(
      'Tool calls:',
      ...toolCalls.map((call) => `- ${call.tool} ${JSON.stringify(call.input ?? null)}`),
    );
  }

  return lines.join('\n');
}

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
  state: CaseState,
): Promise<{ replies: string[]; toolCalls: { tool: string; input: unknown }[] }> {
  const replies: string[] = [];
  const toolCalls: { tool: string; input: unknown }[] = [];
  let turnIndex = 0;

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
      // A fault can land between the turns, the way a lease expiring or a
      // builder dying does in a real run.
      const hook = scenarioCase.betweenTurns?.[turnIndex];
      if (hook) await hook(state, root, harness);
      turnIndex += 1;
      const turn = await runTurn({
        harness,
        directory: root,
        agent: scenarioCase.agent,
        ...(MODEL !== undefined ? { model: MODEL } : {}),
        text,
        timeoutMs: 600_000,
        ...(scenarioCase.rateLimitRetries !== undefined
          ? { rateLimitRetries: scenarioCase.rateLimitRetries }
          : {}),
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

  return { replies, toolCalls };
}
