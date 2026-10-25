import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { globalMcpServers } from './fixture.js';

describe('globalMcpServers', () => {
  it('reads the entries of a config with comments', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oa-mcp-'));
    const path = join(dir, 'opencode.jsonc');
    await writeFile(
      path,
      `{
  // the servers the machine already runs
  "mcp": {
    "github": { "type": "local", "command": ["gh", "mcp"], "enabled": true },
    "exa": { "type": "remote", "url": "https://mcp.exa.ai/mcp" }
  }
}
`,
      'utf8',
    );

    const servers = globalMcpServers(path);

    expect(Object.keys(servers).sort()).toEqual(['exa', 'github']);
    expect(servers.github).toEqual({ type: 'local', command: ['gh', 'mcp'], enabled: true });
    expect(servers.exa).toEqual({ type: 'remote', url: 'https://mcp.exa.ai/mcp' });
  });

  it('drops the environment, so a key is not written into a case directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oa-mcp-'));
    const path = join(dir, 'opencode.json');
    await writeFile(
      path,
      JSON.stringify({
        mcp: {
          exa: {
            type: 'remote',
            url: 'https://mcp.exa.ai/mcp',
            environment: { EXA_API_KEY: 'secret' },
          },
        },
      }),
      'utf8',
    );

    const servers = globalMcpServers(path);

    expect(servers.exa).toEqual({ type: 'remote', url: 'https://mcp.exa.ai/mcp' });
  });

  it('has no servers when the file is missing, unreadable or has none', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oa-mcp-'));
    expect(globalMcpServers(join(dir, 'nothing-here.json'))).toEqual({});

    const path = join(dir, 'opencode.json');
    await writeFile(path, '{ "mcp": "not an object" }', 'utf8');
    expect(globalMcpServers(path)).toEqual({});
  });
});
