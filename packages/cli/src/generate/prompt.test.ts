import { fileURLToPath } from 'node:url';
import { loadRoles } from '@openagentsy/core';
import { describe, expect, it } from 'vitest';
import { renderPrompt } from './prompt.js';

/** The roles file this repository ships. */
const SHIPPED_ROLES = fileURLToPath(new URL('../../../../roles.yaml', import.meta.url));

describe('the critical rules', () => {
  it('tells the Lead to keep its dispatches attached', async () => {
    const roles = await loadRoles(SHIPPED_ROLES);
    const lead = roles.roles.lead;
    if (!lead) throw new Error('no lead role');
    const prompt = renderPrompt(lead);
    expect(prompt).toContain('Dispatch attached, not detached.');
    expect(prompt).toContain('Name the job.');
  });

  it('keeps every rule the role already had', async () => {
    const roles = await loadRoles(SHIPPED_ROLES);
    const lead = roles.roles.lead;
    if (!lead) throw new Error('no lead role');
    const prompt = renderPrompt(lead);
    expect(prompt).toContain('Stay inside the declared scope.');
    expect(prompt).toContain('Report through a board record, not through prose.');
  });

  it('does not tell a worker about dispatches', async () => {
    const roles = await loadRoles(SHIPPED_ROLES);
    const builder = roles.roles.builder;
    if (!builder) throw new Error('no builder role');
    const prompt = renderPrompt(builder);
    expect(prompt).not.toContain('Dispatch attached, not detached.');
    expect(prompt).not.toContain('Name the job.');
  });
});
