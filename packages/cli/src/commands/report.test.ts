import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeDatabase,
  createRecord,
  migrate,
  openDatabase,
  type ProjectRoots,
} from '@openagentsy/core';
import type { Impact } from '@openagentsy/footprint';
import { closeLedger, openLedger, recordFootprint } from '@openagentsy/ledger';
import { describe, expect, it } from 'vitest';
import { formatEthicalReport, runEthicalReport } from './report.js';

/**
 * A project with a run in it.
 *
 * The fixture is the whole state of a project: a ledger with usage, waste,
 * outcomes and a footprint, a board with records, the lessons, the waivers,
 * the audit log, the findings of a check and the evidence of a live
 * observation. Every number the report prints is read out of one of them.
 */

/** The state of a project, as the report reads it. */
async function scratch(): Promise<ProjectRoots> {
  const root = await mkdtemp(join(tmpdir(), 'openagentsy-report-'));
  await seedLedger(root);
  await seedBoard(root);
  await seedStores(root);
  return { workspace: root, stateRoot: root };
}

/** The moment the fixture was written. */
const NOW = new Date().toISOString();

/** The usage insert, with the columns the report reads. */
const USAGE_INSERT = `INSERT INTO usage
  (message_id, session_id, root_session_id, role, provider, model,
   input, output, reasoning, cache_read, cache_write,
   cost_reported, cost_estimated, task_id, ts)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

/** The footprint of one message, as the estimator produced it. */
const IMPACT: Impact = {
  energyWh: [2100, 4800],
  waterL: [210, 980],
  co2Kg: [0.9, 2.1],
  warmingC: [3.1e-17, 7.3e-17],
  dominantUncertainty: 'model-size',
  notes: ['output tokens only (EcoLogits method)'],
};

/** The ledger of the fixture. */
async function seedLedger(root: string): Promise<void> {
  const db = openLedger(root);
  try {
    const usage = db.query(USAGE_INSERT);
    usage.run(
      'msg-1',
      'ses_1',
      'ses_1',
      'builder',
      'anthropic',
      'claude-x',
      100_000,
      200_000,
      50_000,
      0,
      10_000,
      0.42,
      null,
      '2e-4a',
      NOW,
    );
    usage.run(
      'msg-2',
      'ses_1',
      'ses_1',
      'lead',
      'anthropic',
      'claude-x',
      50_000,
      10_000,
      0,
      0,
      0,
      null,
      0.01,
      '2e-4a',
      NOW,
    );
    usage.run(
      'msg-3',
      'ses_2',
      'ses_2',
      'reviewer',
      'ollama',
      'qwen3:8b',
      10_000,
      5_000,
      0,
      0,
      0,
      null,
      null,
      'other-bean',
      NOW,
    );

    const waste = db.query(
      'INSERT INTO waste (root_session_id, message_id, kind, tokens, detail, ts) VALUES (?,?,?,?,?,?)',
    );
    waste.run('ses_1', 'msg-1', 'retry', 100_000, 'the same call twice', NOW);
    waste.run('ses_1', 'msg-1', 'tool_error_loop', 50_000, 'the tool failed', NOW);

    const outcome = db.query(
      'INSERT INTO outcome (root_session_id, task_id, commit_sha, kind, ts) VALUES (?,?,?,?,?)',
    );
    outcome.run('ses_1', '2e-4a', 'abc123', 'task_completed', NOW);
    outcome.run('ses_1', '2e-4a', null, 'task_scrapped', NOW);
    outcome.run('ses_1', '2e-4a', 'abc123', 'commit', NOW);

    recordFootprint(db, 'msg-1', IMPACT);
    seedPolicyFirings(db);
  } finally {
    closeLedger(db);
  }
}

/**
 * The policy firings of the fixture.
 *
 * The rows are the ones §21.3 holds: the policy id, the version it carried
 * when it fired, the session and the outcome.
 */
function seedPolicyFirings(db: ReturnType<typeof openLedger>): void {
  const insert = db.query(
    `INSERT INTO policy_firing
      (id, session_id, policy_id, policy_version, layer, action, severity, reason, origin, ts)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  insert.run(
    'f1',
    'ses_1',
    'oa.anti-sycophancy',
    '1.0.0',
    4,
    'flag',
    'warn',
    null,
    'first-party',
    NOW,
  );
  insert.run(
    'f2',
    'ses_1',
    'oa.anti-sycophancy',
    '1.0.0',
    4,
    'flag',
    'warn',
    null,
    'first-party',
    NOW,
  );
  insert.run(
    'f3',
    'ses_1',
    'oa.anti-sycophancy',
    '1.0.0',
    4,
    'block',
    null,
    'high risk',
    'first-party',
    NOW,
  );
  insert.run('f4', 'ses_1', 'oa.agi-framing', '1.0.0', 4, 'flag', 'info', null, 'first-party', NOW);
  insert.run(
    'f5',
    'ses_1',
    'oa.policy.stack',
    '1.0.0',
    2,
    'allow',
    null,
    'stack-assembled',
    'first-party',
    NOW,
  );
}

/** The board of the fixture. */
async function seedBoard(root: string): Promise<void> {
  const path = join(root, '.openagentsy', 'board.sqlite');
  await mkdir(join(root, '.openagentsy'), { recursive: true });
  const db = openDatabase(path);
  try {
    migrate(db);
    createRecord(db, {
      bean: '2e-4a',
      kind: 'status',
      from: 'oa-builder',
      action: 'The ethical report',
      state: 'the report is written',
      confidence: 'verified',
    });
    createRecord(db, {
      bean: 'memory',
      kind: 'finding',
      from: 'oa-archivist',
      action: 'A candidate memory',
      state: 'candidate',
      confidence: 'inferred',
    });
    createRecord(db, {
      bean: 'other-bean',
      kind: 'status',
      from: 'oa-builder',
      action: 'Something else',
      state: 'done',
      confidence: 'verified',
    });
  } finally {
    closeDatabase(db);
  }
}

/** The stores of the fixture: the lessons, the waivers, the audit and the findings. */
async function seedStores(root: string): Promise<void> {
  const state = join(root, '.openagentsy');
  await mkdir(join(state, 'lessons'), { recursive: true });
  await mkdir(join(state, 'quality'), { recursive: true });

  await writeFile(
    join(state, 'lessons', 'oa-lesson-abcd1234.json'),
    `${JSON.stringify(
      {
        id: 'oa-lesson-abcd1234',
        state: 'candidate',
        summary: 'A call that was made twice',
        occurrences: 2,
        packet: {},
        history: [],
        kind: 'retry',
        detail: 'the same call twice',
        sessions: ['ses_1'],
        created_at: NOW,
        updated_at: NOW,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  await writeFile(
    join(state, 'quality', 'waivers.json'),
    `${JSON.stringify(
      {
        version: 1,
        waivers: [
          {
            ruleId: 'css/no-transition-all',
            path: 'src/app.css',
            reason: 'the transition is deliberate here',
            decidedBy: 'daniel',
            ts: NOW,
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  await writeFile(
    join(state, 'quality', 'findings.json'),
    `${JSON.stringify(
      {
        version: 1,
        tasks: {
          '2e-4a': [
            {
              ruleId: 'a11y/no-aria-label',
              source: 'hallmark:floor-1',
              tier: 'floor',
              file: 'src/app.html',
              line: 4,
              message: 'A control has no name.',
              fix: 'Name the control',
            },
            {
              ruleId: 'css/no-transition-all',
              source: 'hallmark:floor-2',
              tier: 'reflex',
              file: 'src/app.css',
              line: 12,
              message: 'A transition of all moves every property.',
              fix: 'Name the properties to transition instead of all',
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const audit = [
    {
      ts: NOW,
      policyId: 'oa.record.post',
      policyVersion: 'v1',
      actor: 'oa-builder',
      action: 'post',
      resource: '2e-4a',
      effect: 'allow',
    },
    {
      ts: NOW,
      policyId: 'oa.lease.grant',
      policyVersion: 'v1',
      actor: 'oa-lead',
      action: 'grant',
      resource: 'packages/cli/**',
      effect: 'allow',
    },
  ];
  await writeFile(
    join(state, 'audit.jsonl'),
    `${audit.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    'utf8',
  );

  await writeFile(
    join(state, 'conformance.json'),
    `${JSON.stringify(
      {
        version: 1,
        capabilities: {
          'message-token-fields': {
            observations: [
              {
                capabilityId: 'message-token-fields',
                eventType: 'message.tokens',
                at: NOW,
                kind: 'live',
                note: 'the token fields were read off a live message',
                source: { ref: 'session ses_1', date: '2026-10-28' },
              },
            ],
          },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

describe('the ethical report', () => {
  it('renders every section from a seeded project', async () => {
    const roots = await scratch();

    const report = await runEthicalReport(roots);
    const text = formatEthicalReport(report);

    expect(text).toContain('Cost and footprint');
    expect(text).toContain('tokens by role: builder 360k · lead 60k · reviewer 15k');
    expect(text).toContain('spend: $0.42 reported · $0.01 estimated · 1 model unpriced');
    expect(text).toContain('electricity 2.1–4.8 kWh');
    expect(text).toContain('water 210–980 L');
    expect(text).toContain('carbon 0.9–2.1 kg CO2');
    expect(text).toContain('method ecologits-0.11.3');
    expect(text).toContain('Waste');
    expect(text).toContain('34% of tokens went to retries, undos and reverted code');
    expect(text).toContain('Value');
    expect(text).toContain('1 task completed · 1 scrapped task');
    expect(text).toContain('tokens per completed task: 420k');
    expect(text).toContain('Oversight');
    expect(text).toContain('1 lesson to review · 1 memory to triage · 1 waiver recorded');
    expect(text).toContain('open floor findings: 1');
    expect(text).toContain('Conformance');
    expect(text).toContain('unverified:');
  });

  it('shows the policies with the most firings', async () => {
    const roots = await scratch();

    const text = formatEthicalReport(await runEthicalReport(roots));

    expect(text).toContain('Policies');
    expect(text).toContain('oa.anti-sycophancy 3 firings (1.0.0) · 1 blocks · 2 flags');
    expect(text).toContain('oa.agi-framing 1 firing (1.0.0) · 0 blocks · 1 flags');
    const never = text.split('\n').find((entry) => entry.includes('never fired:')) ?? '';
    expect(never).toContain('oa.structural-bias');
  });

  it('reads the firings of one session', async () => {
    const roots = await scratch();

    const text = formatEthicalReport(await runEthicalReport(roots, { session: 'ses_1' }));

    expect(text).toContain('oa.anti-sycophancy 3 firings');
  });

  it('says what nobody computes instead of showing a zero', async () => {
    const roots = await scratch();

    const text = formatEthicalReport(await runEthicalReport(roots));

    expect(text).toContain(
      'board/report mismatches: not computed (no package compares the board with a report)',
    );
    expect(text).toContain('redactions: not computed (no package keeps a counter)');
    expect(text).toContain('grid: not recorded by the ledger');
  });

  it('says that a scope with nothing in it is empty', async () => {
    const roots = await scratch();

    const text = formatEthicalReport(await runEthicalReport(roots, { bean: 'no-such-bean' }));

    expect(text).toContain('bean no-such-bean');
    expect(text).toContain('tokens by role: none — the scope holds no usage rows');
    expect(text).toContain('spend: nothing to price');
    expect(text).toContain('no waste was recorded for the scope');
    expect(text).toContain('the scope holds no outcome');
    expect(text).not.toContain('360k');
  });

  it('reads the rows of one session', async () => {
    const roots = await scratch();

    const text = formatEthicalReport(await runEthicalReport(roots, { session: 'ses_1' }));

    expect(text).toContain('tokens by role: builder 360k · lead 60k');
    expect(text).not.toContain('reviewer');
  });

  it('reads the rows of a window', async () => {
    const roots = await scratch();

    const text = formatEthicalReport(await runEthicalReport(roots, { since: '30d' }));

    expect(text).toContain('the last 30 d');
    expect(text).toContain('tokens by role: builder 360k · lead 60k · reviewer 15k');
  });

  it('refuses a scope that names two things', async () => {
    const roots = await scratch();

    const report = await runEthicalReport(roots, { bean: '2e-4a', session: 'ses_1' });

    expect(report.exitCode).toBe(2);
    expect(report.problem).toContain('names more than one thing');
  });

  it('fails the check while a floor finding is open', async () => {
    const roots = await scratch();

    const report = await runEthicalReport(roots, { check: true });

    expect(report.exitCode).toBe(1);
    expect(report.refusal).toContain('the gate refuses the ship');
    expect(formatEthicalReport(report)).toContain('open floor findings: 1');
  });

  it('passes the check without the flag, because the report is not a gate', async () => {
    const roots = await scratch();

    const report = await runEthicalReport(roots);

    expect(report.exitCode).toBe(0);
  });
});
