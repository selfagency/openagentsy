import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRoles } from '@openagentsy/core';
import { describe, expect, it } from 'vitest';

/**
 * The permission map and the Lead's recovery text.
 *
 * Both live in the roles file, which is the source of truth for every
 * generated agent, so the check reads the real file rather than a fixture.
 */

/** The root of the repository the tests run in. */
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));

/**
 * The tools a person decides with, in both the name the map uses and the
 * name the MCP server exposes them under.
 */
const HUMAN_ONLY_TOOLS = [
  'oa_lesson_decide',
  'openagentsy_lesson_decide',
  'oa_quality_waive',
  'openagentsy_quality_waive',
  'oa_memory_decide',
  'openagentsy_memory_decide',
];

/**
 * The recovery text, from the Lead's guidance.
 *
 * The block is the last one in the guidance, so it runs from the marker to
 * the end of the text.
 */
function recoveryText(guidance: string): string {
  const lines = guidance.split('\n');
  const start = lines.findIndex((line) => line.trim().startsWith('Recovery loop:'));
  if (start === -1) return '';
  return lines.slice(start).join(' ').trim();
}

/** The words of a text. A token is never shorter than a word. */
function words(text: string): string[] {
  return text.split(/\s+/).filter((word) => word.length > 0);
}

describe('the permission map', () => {
  it('denies the three human-only tools to every agent role, in both name forms', async () => {
    const roles = await loadRoles(join(repositoryRoot, 'roles.yaml'));
    expect(Object.keys(roles.roles).length).toBeGreaterThan(0);
    for (const [name, role] of Object.entries(roles.roles)) {
      for (const tool of HUMAN_ONLY_TOOLS) {
        const rules = role.permissions[tool];
        expect(rules, `${name} must carry ${tool}`).toBeDefined();
        expect(rules?.[0]?.effect, `${name} must deny ${tool}`).toBe('deny');
      }
    }
  });
});

describe('the Lead recovery text', () => {
  it('is in the Lead guidance', async () => {
    const roles = await loadRoles(join(repositoryRoot, 'roles.yaml'));
    const lead = roles.roles.lead;
    expect(lead).toBeDefined();
    expect(recoveryText(lead?.guidance ?? '')).not.toBe('');
  });

  it('names the five stages in order', async () => {
    const roles = await loadRoles(join(repositoryRoot, 'roles.yaml'));
    const text = recoveryText(roles.roles.lead?.guidance ?? '');
    const order = ['READ', 'RECOVER', 'DECIDE', 'PERSIST', 'REPORT'].map((stage) =>
      text.indexOf(stage),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('says the report speaks only after the state was written', async () => {
    const roles = await loadRoles(join(repositoryRoot, 'roles.yaml'));
    const text = recoveryText(roles.roles.lead?.guidance ?? '');
    expect(text).toMatch(/REPORT speaks only after PERSIST wrote the state/);
  });

  it('is under 120 tokens', async () => {
    const roles = await loadRoles(join(repositoryRoot, 'roles.yaml'));
    const text = recoveryText(roles.roles.lead?.guidance ?? '');
    const count = words(text).length;
    // A token is never shorter than a word, and a word is never shorter than
    // about one and a half tokens in English, so the estimate is the count
    // times 1.4.
    expect(count).toBeLessThan(120);
    expect(count * 1.4).toBeLessThan(120);
  });
});
