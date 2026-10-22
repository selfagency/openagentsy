import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { checkBudget, listBudgets, recordUsage, setBudget } from './budgets.js';
import { migrate, openDatabase } from './db.js';

let db: DatabaseSync;

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
});

describe('setBudget', () => {
  it('stops at 85 percent of the limit', () => {
    const budget = setBudget(db, { bean: 'proj-42', tokenLimit: 1000 });
    expect(budget.stopAt).toBe(850);
    expect(budget.tokensUsed).toBe(0);
  });

  it('accepts an explicit stop point', () => {
    const budget = setBudget(db, { bean: 'proj-42', tokenLimit: 1000, stopAt: 500 });
    expect(budget.stopAt).toBe(500);
  });

  it('replaces the budget of a bean that already has one', () => {
    setBudget(db, { bean: 'proj-42', tokenLimit: 1000 });
    setBudget(db, { bean: 'proj-42', tokenLimit: 2000 });
    expect(listBudgets(db)).toHaveLength(1);
    expect(listBudgets(db)[0]?.tokenLimit).toBe(2000);
  });

  it('rejects a limit that is not a positive number', () => {
    expect(() => setBudget(db, { bean: 'proj-42', tokenLimit: 0 })).toThrow(/positive/);
  });
});

describe('checkBudget', () => {
  it('does not stop below the stop point', () => {
    setBudget(db, { bean: 'proj-42', tokenLimit: 1000 });
    expect(checkBudget(db, 'proj-42', 849).stop).toBe(false);
  });

  it('stops at the stop point', () => {
    setBudget(db, { bean: 'proj-42', tokenLimit: 1000 });
    expect(checkBudget(db, 'proj-42', 850).stop).toBe(true);
  });

  it('stops above the stop point', () => {
    setBudget(db, { bean: 'proj-42', tokenLimit: 1000 });
    expect(checkBudget(db, 'proj-42', 1200).stop).toBe(true);
  });

  it('reports a bean with no budget as unconfigured rather than stopped', () => {
    const decision = checkBudget(db, 'proj-99', 100);
    expect(decision.configured).toBe(false);
    expect(decision.stop).toBe(false);
  });
});

describe('recordUsage', () => {
  it('stores the tokens spent so far', () => {
    setBudget(db, { bean: 'proj-42', tokenLimit: 1000 });
    const budget = recordUsage(db, 'proj-42', 400);
    expect(budget?.tokensUsed).toBe(400);
    expect(listBudgets(db)[0]?.tokensUsed).toBe(400);
  });

  it('returns nothing for a bean with no budget', () => {
    expect(recordUsage(db, 'proj-99', 400)).toBeUndefined();
  });
});
