import { describe, expect, it } from 'vitest';
import { allow, type PolicyContext } from '../policy.js';
import { PolicyRegistry } from '../policy-registry.js';
import { firstPartyPolicyModules } from './index.js';
import { protectPolicy } from './protect-policy.js';
import { scopeEnforcement } from './scope-enforcement.js';
import { secretScanWrites } from './secret-scan-writes.js';

/**
 * The migrated policy modules (§21.2).
 *
 * A read is not a write: the reader exclusion the hook rules carry has to
 * carry into the policy modules too, or a read of a protected file is
 * treated as a write of it.
 */

/** The workspace the policies that need one are built with. */
const WORKSPACE = '/tmp/openagentsy-policy-migration-test';

/**
 * A key that looks like a credential.
 *
 * The two halves are joined here so the file itself does not hold one.
 */
const SECRET = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');

/** A context of a tool call. */
function ctx(call: {
  name: string;
  args: Record<string, unknown>;
  files?: { path?: string }[];
}): PolicyContext {
  return {
    toolCall: { name: call.name, args: call.args },
    files: call.files ?? [],
    session: { id: 'session-1', roleId: 'oa-builder' },
  };
}

describe('the migrated policy modules', () => {
  it('treats a read of a protected file as a read, not a write', () => {
    const result = protectPolicy.evaluate(
      ctx({
        name: 'read',
        args: { filePath: 'roles.yaml' },
        files: [{ path: 'roles.yaml' }],
      }),
    );

    expect(result.action).toBe('allow');
  });

  it('does not scan the content of a read', () => {
    const result = secretScanWrites.evaluate(
      ctx({ name: 'read', args: { content: `const key = "${SECRET}";` } }),
    );

    expect(result.action).toBe('allow');
  });

  it('reports a scope drift under the legacy finding type', () => {
    const result = scopeEnforcement.evaluate({
      response: { text: 'I also updated src/other/file.ts' },
      scope: { declaredPaths: ['src/app.ts'] },
      session: { id: 'session-1', roleId: 'oa-builder' },
    });

    expect(result.action).toBe('flag');
    const findings = result.action === 'flag' ? result.findings : [];
    expect(findings.map((finding) => finding.type)).toEqual(['out-of-scope-path']);
  });

  it('says why it let a thing through', () => {
    const result = allow('a person approved it');

    expect(result.action).toBe('allow');
    expect(result.reason).toBe('a person approved it');
  });
});

describe('the policy registry', () => {
  it('holds every registered module', () => {
    const registry = new PolicyRegistry(firstPartyPolicyModules({ workspace: WORKSPACE }));

    const ids = registry.all().map((module) => module.id);
    expect(ids).toContain('oa.protect-policy');
    expect(ids).toContain('oa.scope-enforcement');
    expect(registry.all()).toHaveLength(ids.length);
  });

  it('gives one module by its id, and nothing by an id it does not hold', () => {
    const registry = new PolicyRegistry(firstPartyPolicyModules({ workspace: WORKSPACE }));

    expect(registry.get('oa.protect-policy')?.id).toBe('oa.protect-policy');
    expect(registry.get('oa.not-a-policy')).toBeUndefined();
  });
});
