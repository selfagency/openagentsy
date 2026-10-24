import type { RolesFile } from '@openagentsy/core';
import { describe, expect, it } from 'vitest';
import { providerAliasSummary, resolveProviderAlias, selectModels } from './select.js';

const ROLES: RolesFile = {
  version: 1,
  protectedPaths: [],
  roles: {},
};

describe('the provider names', () => {
  it('resolves the alias ollama to the cloud provider', () => {
    // The local provider is not one OpenCode can run, so the name people
    // reach for has to be the one that works.
    expect(resolveProviderAlias('ollama')).toBe('ollama-cloud');
  });

  it('keeps the local provider under the name ollama-local', () => {
    expect(resolveProviderAlias('ollama-local')).toBe('ollama');
  });

  it('names what each alias means', () => {
    const summary = providerAliasSummary();
    expect(summary).toContain('ollama = the Ollama Cloud models');
    expect(summary).toContain('ollama-local = the Ollama models on this machine');
  });

  it('refuses a provider that does not exist', async () => {
    // The name comes from a file a person wrote, and it becomes a key in the
    // inventory of what the provider serves. A name like __proto__ would
    // change that inventory's prototype instead of adding an entry.
    await expect(
      selectModels({
        root: '/tmp/openagentsy-models-test',
        roles: ROLES,
        providers: [{ provider: '__proto__' as 'opencode' }],
        fetchImpl: async () =>
          new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      }),
    ).rejects.toThrow(/unknown provider/);
  });
});
