import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { readApprovalFor } from './project-config.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openagentsy-config-'));
});

describe('readApprovalFor', () => {
  it('reads the commands of the project', async () => {
    await writeFile(
      join(root, 'openagentsy.jsonc'),
      '{ "hooks": { "approvalFor": ["git push", "bun add"] } }',
      'utf8',
    );
    expect(await readApprovalFor(root)).toEqual(['git push', 'bun add']);
  });

  it('reads a config that carries comments and a trailing comma', async () => {
    await writeFile(
      join(root, 'openagentsy.jsonc'),
      [
        '{',
        '  // the commands a person has to approve',
        '  "hooks": {',
        '    /* the list */',
        '    "approvalFor": ["git push"],',
        '  },',
        '}',
      ].join('\n'),
      'utf8',
    );
    expect(await readApprovalFor(root)).toEqual(['git push']);
  });

  it('keeps a marker inside a string out of the comment scan', async () => {
    await writeFile(
      join(root, 'openagentsy.jsonc'),
      '{ "hooks": { "approvalFor": ["git push"] }, "url": "https://example.test/x" }',
      'utf8',
    );
    expect(await readApprovalFor(root)).toEqual(['git push']);
  });

  it('asks for nothing when the project has no config', async () => {
    expect(await readApprovalFor(root)).toEqual([]);
  });

  it('asks for nothing when the config holds no approval list', async () => {
    await writeFile(join(root, 'openagentsy.jsonc'), '{ "hooks": {} }', 'utf8');
    expect(await readApprovalFor(root)).toEqual([]);
  });

  it('asks for nothing when the config cannot be read', async () => {
    await writeFile(join(root, 'openagentsy.jsonc'), '{ "hooks": ', 'utf8');
    expect(await readApprovalFor(root)).toEqual([]);
  });

  it('asks for nothing when the list is not a list of names', async () => {
    await writeFile(join(root, 'openagentsy.jsonc'), '{ "hooks": { "approvalFor": [1] } }', 'utf8');
    expect(await readApprovalFor(root)).toEqual([]);
  });
});
