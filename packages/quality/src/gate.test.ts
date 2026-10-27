import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acceptGate, reviewGate } from './gate.js';
import type { Finding } from './rule.js';

/** A finding of a tier, for the gate to judge. */
function finding(over: Partial<Finding> = {}): Finding {
  return {
    ruleId: 'copy/unsourced-claim',
    source: 'antislop:R-1',
    tier: 'floor',
    file: 'src/page.html',
    line: 3,
    message: 'A number with no source.',
    fix: 'Add the source of the number.',
    ...over,
  };
}

/** What the reviewer returned. */
function review(over: Record<string, unknown> = {}): unknown {
  return { verdict: 'ship', ...over };
}

/** A directory the test writes into. */
async function scratch(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'openagentsy-gate-'));
}

describe('the ship gate', () => {
  it('rejects a ship verdict with an open floor finding as a fabricated pass', () => {
    const result = acceptGate({ raw: review(), findings: [finding()] });

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('fabricated-pass');
    expect(result.openFloor).toHaveLength(1);
    expect(result.openFloor[0]?.ruleId).toBe('copy/unsourced-claim');
  });

  it('rejects an approve verdict with an open floor finding the same way', () => {
    const result = acceptGate({ raw: review({ verdict: 'approve' }), findings: [finding()] });

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('fabricated-pass');
  });

  it('accepts a ship verdict with only reflex findings open, and says so', () => {
    const result = acceptGate({
      raw: review(),
      findings: [finding({ tier: 'reflex', ruleId: 'css/no-transition-all' })],
    });

    expect(result.accepted).toBe(true);
    expect(result.verdict).toBe('ship');
    expect(result.openFloor).toEqual([]);
    expect(result.openReflex).toHaveLength(1);
    expect(result.shippedWithOpenReflex).toBe(true);
  });

  it('accepts a not yet verdict as a refusal', () => {
    const result = acceptGate({ raw: review({ verdict: 'not yet' }), findings: [] });

    expect(result.accepted).toBe(true);
    expect(result.verdict).toBe('fix');
    expect(result.reason).toBeUndefined();
  });

  it('does not let a waived floor finding block the ship', () => {
    const result = acceptGate({
      raw: review(),
      findings: [finding()],
      waivers: { covers: (candidate) => candidate.ruleId === 'copy/unsourced-claim' },
    });

    expect(result.accepted).toBe(true);
    expect(result.openFloor).toEqual([]);
    expect(result.shippedWithOpenReflex).toBe(false);
  });

  it('never trusts the pass the reviewer gives itself', () => {
    const result = acceptGate({
      raw: review({ floor: [], reflex: [] }),
      findings: [finding()],
    });

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('fabricated-pass');
  });

  it('refuses a gate that does not parse', () => {
    const result = acceptGate({ raw: { nothing: true }, findings: [] });

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('invalid-gate');
  });

  it('decides on its input alone', () => {
    const findings = [finding()];
    const first = acceptGate({ raw: review(), findings });
    const second = acceptGate({ raw: review(), findings });

    expect(first).toEqual(second);
    expect(findings).toHaveLength(1);
  });

  it('reads the words of a verdict as they are written', () => {
    expect(acceptGate({ raw: review({ verdict: 'SHIP' }), findings: [] }).verdict).toBe('ship');
    expect(acceptGate({ raw: review({ verdict: 'approve' }), findings: [] }).verdict).toBe('ship');
    expect(acceptGate({ raw: review({ verdict: 'not yet' }), findings: [] }).verdict).toBe('fix');
    expect(acceptGate({ raw: review({ verdict: 'rebuild' }), findings: [] }).verdict).toBe(
      'rebuild',
    );
  });

  it('keeps the review of the reviewer, so the record says what it said', () => {
    const result = acceptGate({
      raw: review({
        purpose: [{ technique: 'a gradient', reason: 'it carries the brand' }],
        liveliness: { energy: 4, rhythm: 6, motion: 2, note: 'calm' },
      }),
      findings: [],
    });

    expect(result.review?.purpose).toHaveLength(1);
    expect(result.review?.liveliness?.note).toBe('calm');
  });
});

describe('the review of a change', () => {
  it('re-runs the check, so a ship verdict over a real finding is refused', async () => {
    const root = await scratch();
    await writeFile(join(root, 'page.html'), '<p>Save 50% today</p>\n', 'utf8');

    const result = await reviewGate({ raw: review(), files: ['page.html'], root });

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('fabricated-pass');
    expect(result.openFloor[0]?.ruleId).toBe('copy/unsourced-claim');
  });

  it('accepts a ship verdict when the re-run finds nothing', async () => {
    const root = await scratch();
    await writeFile(join(root, 'page.html'), '<p>Hello.</p>\n', 'utf8');

    const result = await reviewGate({ raw: review(), files: ['page.html'], root });

    expect(result.accepted).toBe(true);
    expect(result.openFloor).toEqual([]);
  });

  it('lets a waiver cover a finding of the re-run', async () => {
    const root = await scratch();
    await writeFile(join(root, 'page.html'), '<p>Save 50% today</p>\n', 'utf8');

    const result = await reviewGate({
      raw: review(),
      files: ['page.html'],
      root,
      waivers: { covers: () => true },
    });

    expect(result.accepted).toBe(true);
    expect(result.openFloor).toEqual([]);
  });
});
