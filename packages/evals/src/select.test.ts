import { describe, expect, it } from 'vitest';
import { SCENARIOS, selectCases } from './scenarios.js';

describe('selectCases', () => {
  it('runs every case when nothing says what changed', () => {
    expect(selectCases(SCENARIOS, [])).toHaveLength(SCENARIOS.length);
  });

  it('runs only the cases that read the file that changed', () => {
    const selected = selectCases(SCENARIOS, ['packages/mcp/src/server.ts']);
    expect(selected.length).toBeGreaterThan(0);
    expect(selected.length).toBeLessThan(SCENARIOS.length);
    expect(selected.map((c) => c.name)).toContain('budget stop');
  });

  it('runs every case when the roles changed', () => {
    // The roles decide how every agent behaves, so every verdict can move.
    expect(selectCases(SCENARIOS, ['roles.yaml'])).toHaveLength(SCENARIOS.length);
  });

  it('runs nothing when the change reads no case', () => {
    // A document cannot move a verdict, and the run that costs the most and
    // says the least is the one that answers a question nobody asked.
    expect(selectCases(SCENARIOS, ['README.md'])).toHaveLength(0);
  });

  it('runs every case when a source change covers nothing', () => {
    // A change nobody mapped is a change nobody knows the effect of. The
    // safe answer is the whole suite.
    expect(selectCases(SCENARIOS, ['packages/core/src/roles.ts'])).toHaveLength(SCENARIOS.length);
  });

  it('runs every case when the harness itself changed', () => {
    expect(selectCases(SCENARIOS, ['packages/evals/src/evals.test.ts'])).toHaveLength(
      SCENARIOS.length,
    );
  });

  it('never selects a case twice', () => {
    const selected = selectCases(SCENARIOS, [
      'packages/mcp/src/server.ts',
      'packages/mcp/src/server.ts',
      'packages/core/src/board/leases.ts',
    ]);
    expect(new Set(selected.map((c) => c.name)).size).toBe(selected.length);
  });
});
