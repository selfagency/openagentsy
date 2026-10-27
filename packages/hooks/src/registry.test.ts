import { describe, expect, it } from 'vitest';
import { BLOCK_PRIORITY, createOaRegistry, orderRules, type Rule, run } from './registry.js';

/** A rule that records that it ran and lets the call through. */
function recording(id: string, ran: string[], options: Partial<Rule> = {}): Rule {
  return {
    id,
    event: 'PreToolCall',
    handler: () => {
      ran.push(id);
      return { continue: true };
    },
    ...options,
  };
}

describe('the registry', () => {
  it('runs the blocking rules first, then the priority, then the order they were written', () => {
    const ran: string[] = [];
    const rules = [
      recording('plain', ran),
      recording('blocking', ran, { block: true }),
      recording('high', ran, { priority: 10 }),
      recording('low', ran, { priority: 1 }),
      recording('second-plain', ran),
    ];
    expect(orderRules(rules).map((rule) => rule.id)).toEqual([
      'blocking',
      'high',
      'low',
      'plain',
      'second-plain',
    ]);
  });

  it('puts a blocking rule above a rule with a higher priority', () => {
    const ran: string[] = [];
    const rules = [
      recording('high', ran, { priority: BLOCK_PRIORITY * 10 }),
      recording('blocking', ran, { block: true }),
    ];
    expect(orderRules(rules).map((rule) => rule.id)).toEqual(['blocking', 'high']);
  });

  it('stops the chain at the first rule that stops it and keeps the reason', async () => {
    const ran: string[] = [];
    const rules: Rule[] = [
      {
        id: 'first',
        event: 'PreToolCall',
        handler: () => {
          ran.push('first');
          return { continue: true };
        },
      },
      {
        id: 'second',
        event: 'PreToolCall',
        handler: () => {
          ran.push('second');
          return { continue: false, reason: 'the reason' };
        },
      },
      {
        id: 'third',
        event: 'PreToolCall',
        handler: () => {
          ran.push('third');
          return { continue: true };
        },
      },
    ];
    const result = await run('PreToolCall', rules, {});
    expect(result.continue).toBe(false);
    expect(result.reasons).toEqual(['the reason']);
    expect(ran).toEqual(['first', 'second']);
  });

  it('returns the transforms in order and lets the call through', async () => {
    const rules: Rule[] = [
      { id: 'a', event: 'PreToolCall', handler: () => ({ transform: { a: 1 } }) },
      { id: 'b', event: 'PreToolCall', handler: () => ({ transform: { b: 2 } }) },
    ];
    const result = await run('PreToolCall', rules, {});
    expect(result.continue).toBe(true);
    expect(result.transformed).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('runs only the rules of the moment', async () => {
    const ran: string[] = [];
    const rules = [
      recording('before', ran),
      { ...recording('after', ran), event: 'PostToolCall' as const },
    ];
    await run('PreToolCall', rules, {});
    expect(ran).toEqual(['before']);
  });

  it('runs a rule only for the roles it names', async () => {
    const ran: string[] = [];
    const rules = [recording('builders', ran, { roles: ['builder'] })];
    await run('PreToolCall', rules, { role: 'lead' });
    expect(ran).toEqual([]);
    await run('PreToolCall', rules, { role: 'builder' });
    expect(ran).toEqual(['builders']);
  });

  it('runs a scoped rule for nobody when the role is unknown', async () => {
    const ran: string[] = [];
    const rules = [recording('builders', ran, { roles: ['builder'] })];
    await run('PreToolCall', rules, {});
    expect(ran).toEqual([]);
  });

  it('gives the registry the rules in the order they run', () => {
    const ran: string[] = [];
    const registry = createOaRegistry([
      recording('plain', ran),
      recording('blocking', ran, { block: true }),
    ]);
    expect(registry.rules().map((rule) => rule.id)).toEqual(['blocking', 'plain']);
    expect(registry.rules('PreToolCall').map((rule) => rule.id)).toEqual(['blocking', 'plain']);
    expect(registry.rules('PostToolCall')).toEqual([]);
  });
});
