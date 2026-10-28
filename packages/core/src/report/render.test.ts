import { describe, expect, it } from 'vitest';
import { ethicalReportJson, renderEthicalReport } from './render.js';
import type { ReportFacts } from './types.js';

/**
 * The facts of a run that cost something and was worth something.
 *
 * The numbers are the ones of a seeded ledger, so a test can say what the
 * report must show and the report has to show exactly that.
 */
function facts(over: Partial<ReportFacts> = {}): ReportFacts {
  return {
    scope: { kind: 'project' },
    cost: {
      present: true,
      messages: 42,
      tokens: 1_728_000,
      roles: [
        { role: 'builder', tokens: 1_100_000, usd: 12.4, unpriced: 0 },
        { role: 'lead', tokens: 412_000, usd: 1.8, unpriced: 0 },
        { role: 'reviewer', tokens: 96_000, usd: 0.62, unpriced: 3 },
      ],
      reportedUsd: 14.82,
      estimatedUsd: 1.19,
      unpricedModels: 3,
      unpricedMessages: 3,
    },
    footprint: {
      present: true,
      energyKwh: [2.1, 4.8],
      waterL: [210, 980],
      co2Kg: [0.9, 2.1],
      method: 'ecologits-0.11.3',
      dominantUncertainty: 'model-size',
      grid: null,
      undisclosedProviders: 1,
    },
    waste: {
      present: true,
      tokens: 311_040,
      percentage: 18,
      byKind: [
        { kind: 'retry', count: 4, tokens: 155_520, percentage: 9 },
        { kind: 'tool_error_loop', count: 2, tokens: 69_120, percentage: 4 },
        { kind: 'undo', count: 1, tokens: 51_840, percentage: 3 },
      ],
    },
    value: {
      present: true,
      tasksCompleted: 6,
      tasksScrapped: 1,
      commits: 9,
      prsMerged: 2,
      tokensPerTask: 214_000,
      tokensPerCommit: 41_000,
      offloadMessages: 5,
      offloadTokens: 41_000,
      offloadUsd: 0.01,
      offloadCloudUsd: 0.13,
      offloadSavedUsd: 0.12,
    },
    oversight: {
      records: 14,
      lessons: 3,
      memory: 1,
      waivers: 2,
      auditEntries: 42,
      openFloor: 0,
      openFloorFindings: [],
      mismatches: { known: false, reason: 'no package compares the board with a report' },
      redactions: { known: false, reason: 'no package keeps a counter' },
    },
    conformance: {
      total: 18,
      observed: 10,
      provenStatic: 5,
      unverified: 3,
      unverifiedIds: ['mcp-tool-prefix', 'prompt-insert', 'memory-inbox-keymap'],
      pluginOrderWarnings: [
        { plugin: 'yaml-hooks', detail: 'yaml-hooks runs after the OpenAgentsy checks' },
      ],
    },
    policies: {
      present: true,
      firings: 42,
      top: [
        {
          policyId: 'oa.anti-sycophancy',
          count: 12,
          blocks: 1,
          flags: 4,
          versions: ['1.0.0'],
        },
        { policyId: 'oa.agi-framing', count: 8, blocks: 0, flags: 2, versions: ['1.0.0'] },
      ],
      neverFired: ['oa.structural-bias'],
    },
    ...over,
  };
}

describe('the ethical report', () => {
  it('names the scope it is about', () => {
    expect(renderEthicalReport(facts())).toContain(
      'OpenAgentsy run report — project, the whole ledger',
    );
  });

  it('shows the tokens per role and the spend', () => {
    const text = renderEthicalReport(facts());
    expect(text).toContain('tokens by role: builder 1.1M · lead 412k · reviewer 96k');
    expect(text).toContain('spend: $14.82 reported · $1.19 estimated · 3 models unpriced');
  });

  it('shows the footprint as the bounds the estimator produced', () => {
    const text = renderEthicalReport(facts());
    expect(text).toContain('electricity 2.1–4.8 kWh');
    expect(text).toContain('water 210–980 L');
    expect(text).toContain('carbon 0.9–2.1 kg CO2');
    expect(text).toContain('method ecologits-0.11.3 · dominant uncertainty: model-size');
  });

  it('shows the waste as the share of the tokens and the kinds', () => {
    const text = renderEthicalReport(facts());
    expect(text).toContain('18% of tokens went to retries, undos and reverted code');
    expect(text).toContain('retry 9% · tool_error_loop 4% · undo 3%');
  });

  it('shows the value as the outcomes and the offload', () => {
    const text = renderEthicalReport(facts());
    expect(text).toContain('6 tasks completed · 1 scrapped task');
    expect(text).toContain('tokens per completed task: 214k');
    expect(text).toContain('offload saved 41k tokens off the cloud (~$0.12 of cloud spend)');
  });

  it('shows the oversight, and says what nobody computes', () => {
    const text = renderEthicalReport(facts());
    expect(text).toContain('3 lessons to review · 1 memory to triage · 2 waivers recorded');
    expect(text).toContain('open floor findings: 0');
    expect(text).toContain(
      'board/report mismatches: not computed (no package compares the board with a report)',
    );
    expect(text).toContain('redactions: not computed (no package keeps a counter)');
  });

  it('names the capabilities nobody has verified', () => {
    const text = renderEthicalReport(facts());
    expect(text).toContain('10/18 observed · 5 proven_static · 3 unverified');
    expect(text).toContain('unverified: mcp-tool-prefix, prompt-insert, memory-inbox-keymap');
  });

  it('shows the policies with the most firings', () => {
    const text = renderEthicalReport(facts());
    expect(text).toContain('Policies');
    expect(text).toContain('42 firings');
    expect(text).toContain('oa.anti-sycophancy 12 firings (1.0.0) · 1 blocks · 4 flags');
    expect(text).toContain('oa.agi-framing 8 firings (1.0.0) · 0 blocks · 2 flags');
    expect(text).toContain('never fired: oa.structural-bias');
  });

  it('says that a scope with no policy firing is empty', () => {
    const empty = facts({
      policies: { present: false, firings: 0, top: [], neverFired: [] },
    });
    expect(renderEthicalReport(empty)).toContain('no policy fired for the scope');
  });

  it('carries no colour', () => {
    const text = renderEthicalReport(facts());
    expect(text.includes('\u001b')).toBe(false);
  });

  it('says that a scope with nothing in it is empty, and prints no zeroes', () => {
    const empty = facts({
      scope: { kind: 'bean', id: '2e-9a' },
      cost: {
        present: false,
        messages: 0,
        tokens: 0,
        roles: [],
        reportedUsd: null,
        estimatedUsd: null,
        unpricedModels: 0,
        unpricedMessages: 0,
      },
      waste: { present: false, tokens: 0, percentage: 0, byKind: [] },
      value: {
        present: false,
        tasksCompleted: 0,
        tasksScrapped: 0,
        commits: 0,
        prsMerged: 0,
        tokensPerTask: null,
        tokensPerCommit: null,
        offloadMessages: 0,
        offloadTokens: 0,
        offloadUsd: null,
        offloadCloudUsd: null,
        offloadSavedUsd: null,
      },
    });
    const text = renderEthicalReport(empty);
    expect(text).toContain('OpenAgentsy run report — bean 2e-9a, the rows whose task is that bean');
    expect(text).toContain('tokens by role: none — the scope holds no usage rows');
    expect(text).toContain('no waste was recorded for the scope');
    expect(text).toContain('the scope holds no outcome');
    expect(text).not.toContain('0 tokens');
  });

  it('carries the same facts in the JSON', () => {
    const json = ethicalReportJson(facts()) as {
      scope: { kind: string };
      cost: { tokens: number };
      policies: { top: { policyId: string }[] };
    };
    expect(json.scope.kind).toBe('project');
    expect(json.cost.tokens).toBe(1_728_000);
    expect(json.policies.top[0]?.policyId).toBe('oa.anti-sycophancy');
  });
});
