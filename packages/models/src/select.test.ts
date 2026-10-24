import type { RolesFile } from '@openagentsy/core';
import { describe, expect, it } from 'vitest';
import { selectModels } from './select.js';

const ROLES: RolesFile = {
  version: 1,
  protectedPaths: [],
  roles: {},
};

describe('the provider names', () => {
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
