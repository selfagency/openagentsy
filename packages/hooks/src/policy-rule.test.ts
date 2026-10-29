import type { PolicyFiring, PolicyFiringSink } from '@openagentsy/core';
import { describe, expect, it } from 'vitest';
import {
  allow,
  block,
  flag,
  type PolicyFinding,
  type PolicyModule,
  type PolicyResult,
} from './policy.js';
import { approvalPolicyRule, policyContextOf, policyRule } from './policy-rule.js';
import type { HandlerResult } from './registry.js';

/**
 * The bridge between a policy module and the rule the registry runs.
 *
 * The rule is what the guard path calls, and the policy is what decides. The
 * bridge is the seam: it reads the event into the context the policies
 * expect, maps the decision onto the outcome of the rule, and leaves a row
 * behind for every evaluation, so the log says what fired and which version
 * of the policy fired it.
 */

/** A sink that keeps the firings in memory. */
class Sink implements PolicyFiringSink {
  /** The rows the sink was given. */
  readonly firings: PolicyFiring[] = [];

  record(firing: PolicyFiring): void {
    this.firings.push(firing);
  }
}

/** A policy that decides what the test says. */
function moduleOf(result: PolicyResult): PolicyModule {
  return {
    id: 'oa.test-policy',
    version: '1.2.3',
    layer: 4,
    description: 'a policy of the test',
    appliesTo: ['PreToolCall'],
    origin: 'first-party',
    evaluate: () => result,
  };
}

/** A shell call, as the host hands it over. */
function shell(command = 'ls -la'): unknown {
  return { toolName: 'bash', args: { command }, files: [], sessionID: 'ses_1', role: 'oa-builder' };
}

describe('the policy context', () => {
  it('reads a tool call into the shape the policies expect', () => {
    const ctx = policyContextOf({
      toolName: 'write',
      args: { filePath: 'src/a.ts', content: 'x' },
      files: [{ path: 'src/a.ts' }],
      sessionID: 'ses_1',
      role: 'oa-builder',
    });

    expect(ctx.session).toEqual({ id: 'ses_1', roleId: 'oa-builder' });
    expect(ctx.toolCall?.name).toBe('write');
    expect(ctx.toolCall?.args).toEqual({ filePath: 'src/a.ts', content: 'x' });
    expect(ctx.files).toEqual([{ path: 'src/a.ts' }]);
  });

  it('reads a reply into the shape the policies expect', () => {
    const ctx = policyContextOf({
      type: 'PreResponse',
      sessionID: 'ses_2',
      text: 'You are right.',
    });

    expect(ctx.session.id).toBe('ses_2');
    expect(ctx.response?.text).toBe('You are right.');
    expect(ctx.toolCall).toBeUndefined();
  });

  it('names the session and the role it was not given', () => {
    const ctx = policyContextOf({ toolName: 'bash', args: {}, files: [] });

    expect(ctx.session.id).toBe('unknown');
    expect(ctx.session.roleId).toBe('unknown');
  });

  it('carries the paths the task may touch', () => {
    const ctx = policyContextOf(
      { type: 'PreResponse', text: 'I edited src/a.ts.' },
      {
        statedPaths: ['src/a.ts'],
      },
    );

    expect(ctx.scope?.declaredPaths).toEqual(['src/a.ts']);
  });
});

describe('a rule that runs a policy', () => {
  it('lets an allowed call through and records one row', async () => {
    const sink = new Sink();
    const rule = policyRule(moduleOf(allow()), { id: 'test-rule', block: true, firings: sink });

    const result = await rule.handler(shell());

    expect(result).toEqual({ continue: true });
    expect(sink.firings).toHaveLength(1);
    expect(sink.firings[0]).toMatchObject({
      sessionId: 'ses_1',
      policyId: 'oa.test-policy',
      policyVersion: '1.2.3',
      layer: 4,
      action: 'allow',
      origin: 'first-party',
    });
  });

  it('refuses a blocked call with the reason of the policy', async () => {
    const sink = new Sink();
    const rule = policyRule(moduleOf(block('not this way')), {
      id: 'test-rule',
      block: true,
      firings: sink,
    });

    const result = await rule.handler(shell());

    expect(result).toEqual({ continue: false, reason: 'not this way' });
    expect(sink.firings).toHaveLength(1);
    expect(sink.firings[0]?.action).toBe('block');
    expect(sink.firings[0]?.reason).toBe('not this way');
  });

  it('flags a call, reports the findings and records one row', async () => {
    const sink = new Sink();
    const found: PolicyFinding[] = [];
    const rule = policyRule(
      moduleOf(
        flag(
          [
            { policyId: 'oa.test-policy', type: 'praise', match: 'great point' },
            { policyId: 'oa.test-policy', type: 'agreement', match: 'you are right' },
          ],
          'warn',
        ),
      ),
      { id: 'test-rule', onFindings: (findings) => found.push(...findings), firings: sink },
    );

    const result = await rule.handler(shell());

    expect(result).toEqual({ continue: true });
    expect(found).toHaveLength(2);
    // One row for the evaluation, and not one row for every finding.
    expect(sink.firings).toHaveLength(1);
    expect(sink.firings[0]?.action).toBe('flag');
    expect(sink.firings[0]?.severity).toBe('warn');
  });

  it('passes a transform on', async () => {
    const rule = policyRule(moduleOf({ action: 'transform', payload: { content: 'changed' } }), {
      id: 'test-rule',
    });

    const result = await rule.handler(shell());

    expect(result).toEqual({ transform: { content: 'changed' } });
  });

  it('records nothing when there is no sink', async () => {
    const rule = policyRule(moduleOf(allow()), { id: 'test-rule' });

    const result = await rule.handler(shell());

    expect(result).toEqual({ continue: true });
  });
});

describe('the rule that asks a person', () => {
  it('records the refusal of the gate as a block', async () => {
    const sink = new Sink();
    const gate = async (): Promise<HandlerResult> => ({
      continue: false,
      reason: 'a person must approve it',
    });
    const rule = approvalPolicyRule(moduleOf(block('this command destroys something')), {
      id: 'test-rule',
      block: true,
      gate,
      firings: sink,
    });

    const result = await rule.handler(shell('rm -rf /'));

    expect(result).toEqual({ continue: false, reason: 'a person must approve it' });
    expect(sink.firings).toHaveLength(1);
    expect(sink.firings[0]?.action).toBe('block');
    expect(sink.firings[0]?.reason).toBe('a person must approve it');
  });

  it('records the approval as the reason of the allow', async () => {
    const sink = new Sink();
    const gate = async (): Promise<HandlerResult> => ({ continue: true });
    const rule = approvalPolicyRule(moduleOf(block('this command destroys something')), {
      id: 'test-rule',
      block: true,
      gate,
      firings: sink,
    });

    const result = await rule.handler(shell('rm -rf /'));

    expect(result).toEqual({ continue: true });
    expect(sink.firings).toHaveLength(1);
    expect(sink.firings[0]?.action).toBe('allow');
    expect(sink.firings[0]?.reason).toContain('approved');
  });

  it('records an ordinary call as an allow', async () => {
    const sink = new Sink();
    const gate = async (): Promise<HandlerResult> => ({ continue: true });
    const rule = approvalPolicyRule(moduleOf(allow()), {
      id: 'test-rule',
      block: true,
      gate,
      firings: sink,
    });

    const result = await rule.handler(shell('ls -la'));

    expect(result).toEqual({ continue: true });
    expect(sink.firings).toHaveLength(1);
    expect(sink.firings[0]?.action).toBe('allow');
    expect(sink.firings[0]?.reason).toBeUndefined();
  });
});
