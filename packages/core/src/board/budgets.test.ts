import { beforeEach, describe, expect, it } from 'vitest';
import { checkBudget, listBudgets, recordUsage, setBudget } from './budgets.js';
import type { BoardDatabase } from './db.js';
import { migrate, openDatabase } from './db.js';

let db: BoardDatabase;

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

  it('stops on what the board already recorded', () => {
    // The board holds the last report of what the bean spent. The caller
    // reports what it thinks it spent, and a caller that does not know
    // reports zero. The board's own number is the one that counts: a bean
    // that is over its budget is over it, whoever asks.
    setBudget(db, { bean: 'proj-42', tokenLimit: 1000 });
    recordUsage(db, 'proj-42', 2000);
    const decision = checkBudget(db, 'proj-42', 0);
    expect(decision.stop).toBe(true);
    expect(decision.tokensUsed).toBe(2000);
  });

  it('keeps the higher of the two numbers', () => {
    setBudget(db, { bean: 'proj-42', tokenLimit: 1000 });
    recordUsage(db, 'proj-42', 400);
    const decision = checkBudget(db, 'proj-42', 900);
    expect(decision.tokensUsed).toBe(900);
    expect(decision.stop).toBe(true);
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

describe('the ledger is the measurement', () => {
  it('stops on what the ledger measured, with no self-report at all', () => {
    // The exit test of 2b: the ledger counted the tokens and nobody reported
    // anything. The board's own usage is still zero, and the verdict is the
    // measured one.
    setBudget(db, { bean: 'proj-42', tokenLimit: 1000 });
    const decision = checkBudget(db, 'proj-42', 0, {
      total: (bean) => (bean === 'proj-42' ? 900 : undefined),
    });
    expect(decision.tokensUsed).toBe(900);
    expect(decision.stop).toBe(true);
  });

  it('ignores the self-report when the ledger has a number', () => {
    // The ledger is the measurement, so a caller that reports a smaller
    // number does not get to lower the verdict.
    setBudget(db, { bean: 'proj-42', tokenLimit: 1000 });
    recordUsage(db, 'proj-42', 100);
    const decision = checkBudget(db, 'proj-42', 100, {
      total: () => 900,
    });
    expect(decision.tokensUsed).toBe(900);
    expect(decision.stop).toBe(true);
  });

  it('falls back to the self-report when there is no reader', () => {
    // A board without a ledger keeps working: the number it was told is the
    // number it uses.
    setBudget(db, { bean: 'proj-42', tokenLimit: 1000 });
    const decision = checkBudget(db, 'proj-42', 900);
    expect(decision.tokensUsed).toBe(900);
    expect(decision.stop).toBe(true);
  });

  it('falls back when the reader has nothing to say', () => {
    setBudget(db, { bean: 'proj-42', tokenLimit: 1000 });
    recordUsage(db, 'proj-42', 900);
    const decision = checkBudget(db, 'proj-42', 0, { total: () => undefined });
    expect(decision.tokensUsed).toBe(900);
    expect(decision.stop).toBe(true);
  });

  it('does not stop a bean the ledger says is under its cap', () => {
    setBudget(db, { bean: 'proj-42', tokenLimit: 1000 });
    recordUsage(db, 'proj-42', 2000);
    const decision = checkBudget(db, 'proj-42', 2000, { total: () => 100 });
    expect(decision.tokensUsed).toBe(100);
    expect(decision.stop).toBe(false);
  });
});

describe('the yellow window', () => {
  it('warns once when the bean crosses eighty percent', () => {
    setBudget(db, { bean: 'proj-42', tokenLimit: 1000 });
    const first = checkBudget(db, 'proj-42', 810, { total: () => 810 });
    expect(first.warning).toContain('yellow window');

    // The second check is still in the window, and the warning is owed once.
    const second = checkBudget(db, 'proj-42', 820, { total: () => 820 });
    expect(second.warning).toBeUndefined();
  });

  it('warns again after the bean is back under the window', () => {
    setBudget(db, { bean: 'proj-42', tokenLimit: 1000 });
    checkBudget(db, 'proj-42', 810, { total: () => 810 });

    const under = checkBudget(db, 'proj-42', 100, { total: () => 100 });
    expect(under.warning).toBeUndefined();

    const again = checkBudget(db, 'proj-42', 900, { total: () => 900 });
    expect(again.warning).toContain('yellow window');
  });

  it('does not warn a bean that is under the window', () => {
    setBudget(db, { bean: 'proj-42', tokenLimit: 1000 });
    const decision = checkBudget(db, 'proj-42', 799, { total: () => 799 });
    expect(decision.warning).toBeUndefined();
  });

  it('warns on a turn that crosses its own cap', () => {
    setBudget(db, { bean: 'proj-42', tokenLimit: 100000, turnLimit: 1000 });
    const decision = checkBudget(db, 'proj-42', 0, {
      total: () => 10,
      turn: () => 900,
    });
    expect(decision.warning).toContain('turn');
  });
});

describe('the turn and session caps', () => {
  it('stops a turn that went over its cap', () => {
    setBudget(db, { bean: 'proj-42', tokenLimit: 100000, turnLimit: 1000 });
    const decision = checkBudget(db, 'proj-42', 0, {
      total: () => 10,
      turn: () => 1200,
    });
    expect(decision.turnStop).toBe(true);
    expect(decision.turnTokens).toBe(1200);
    expect(decision.turnLimit).toBe(1000);
    // The bean's own cap is nowhere near.
    expect(decision.stop).toBe(false);
  });

  it('stops a session that went over its cap', () => {
    setBudget(db, { bean: 'proj-42', tokenLimit: 100000, sessionLimit: 5000 });
    const decision = checkBudget(db, 'proj-42', 0, {
      total: () => 10,
      session: () => 6000,
    });
    expect(decision.sessionStop).toBe(true);
    expect(decision.sessionTokens).toBe(6000);
    expect(decision.sessionLimit).toBe(5000);
  });

  it('does not stop a turn that is under its cap', () => {
    setBudget(db, { bean: 'proj-42', tokenLimit: 100000, turnLimit: 1000 });
    const decision = checkBudget(db, 'proj-42', 0, {
      total: () => 10,
      turn: () => 900,
    });
    expect(decision.turnStop).toBe(false);
  });

  it('does not stop on a cap that was never measured', () => {
    // A cap that is not measured is not broken: the reading is missing, and
    // a missing reading is not a verdict.
    setBudget(db, { bean: 'proj-42', tokenLimit: 100000, turnLimit: 1000 });
    const decision = checkBudget(db, 'proj-42', 0, { total: () => 10 });
    expect(decision.turnStop).toBe(false);
    expect(decision.turnTokens).toBeUndefined();
  });

  it('leaves the caps of a bean that has none undefined', () => {
    setBudget(db, { bean: 'proj-42', tokenLimit: 1000 });
    const decision = checkBudget(db, 'proj-42', 0, { total: () => 10 });
    expect(decision.turnLimit).toBeUndefined();
    expect(decision.sessionLimit).toBeUndefined();
    expect(decision.turnStop).toBe(false);
    expect(decision.sessionStop).toBe(false);
  });
});

describe('setBudget with the turn and session caps', () => {
  it('keeps the caps it is given', () => {
    const budget = setBudget(db, {
      bean: 'proj-42',
      tokenLimit: 1000,
      turnLimit: 500,
      sessionLimit: 2000,
    });
    expect(budget.turnLimit).toBe(500);
    expect(budget.sessionLimit).toBe(2000);
  });

  it('leaves a cap that is not named as it was', () => {
    setBudget(db, { bean: 'proj-42', tokenLimit: 1000, turnLimit: 500 });
    const budget = setBudget(db, { bean: 'proj-42', tokenLimit: 2000 });
    expect(budget.turnLimit).toBe(500);
    expect(budget.tokenLimit).toBe(2000);
  });

  it('rejects a cap that is not a positive number', () => {
    expect(() => setBudget(db, { bean: 'proj-42', tokenLimit: 1000, turnLimit: 0 })).toThrow(
      /positive/,
    );
  });
});
