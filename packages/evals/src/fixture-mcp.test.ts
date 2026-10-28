import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { caseMcp, globalMcpServers } from './fixture.js';
import type { OpenCodeRuntime } from './opencode.js';

const V1: OpenCodeRuntime = { binary: 'opencode', version: '1.19.4', major: 1 };
const V2: OpenCodeRuntime = { binary: 'opencode', version: '2.2.0', major: 2 };

/** A file in a directory of its own. */
async function configFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'oa-mcp-'));
  const path = join(dir, 'opencode.jsonc');
  await writeFile(path, content, 'utf8');
  return path;
}

describe('globalMcpServers', () => {
  it('reads the entries of a config with comments', async () => {
    const path = await configFile(`{
  // the servers the machine already runs
  "mcp": {
    "github": { "type": "local", "command": ["gh", "mcp"], "enabled": true },
    "exa": { "type": "remote", "url": "https://mcp.exa.ai/mcp" }
  }
}
`);

    const { servers, notes } = globalMcpServers(path);

    expect(Object.keys(servers).sort()).toEqual(['exa', 'github']);
    expect(servers.github).toEqual({ type: 'local', command: ['gh', 'mcp'], enabled: true });
    expect(servers.exa).toEqual({ type: 'remote', url: 'https://mcp.exa.ai/mcp' });
    expect(notes).toEqual([]);
  });

  it('reads the nested shape of OpenCode 2', async () => {
    // The measured shape (2026-10-27): the machine's config nests the
    // servers, and the harness copied the whole map as one entry named
    // "servers". The server ignores an entry without a type ("Ignoring MCP
    // config entry without type"), so the case ran with an entry the server
    // silently dropped.
    const path = await configFile(`{
  "mcp": {
    "servers": {
      "github": { "type": "local", "command": ["gh", "mcp"] },
      "exa": { "type": "remote", "url": "https://mcp.exa.ai/mcp" }
    }
  }
}
`);

    const { servers, notes } = globalMcpServers(path);

    expect(Object.keys(servers).sort()).toEqual(['exa', 'github']);
    expect(servers.github).toEqual({ type: 'local', command: ['gh', 'mcp'] });
    expect(notes).toEqual([]);
  });

  it('drops an entry without a type, and says which one', async () => {
    // The server ignores an entry without a type ("Ignoring MCP config
    // entry without type"), and a case that runs with an entry the server
    // ignores is a case whose green says nothing about the agent.
    const path = await configFile(`{
  "mcp": {
    "github": { "type": "local", "command": ["gh", "mcp"] },
    "broken": { "command": ["broken-mcp"] }
  }
}
`);

    const { servers, notes } = globalMcpServers(path);

    expect(servers).toEqual({ github: { type: 'local', command: ['gh', 'mcp'] } });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('without a type');
    expect(notes[0]).toContain(path);
  });

  it('keeps a server that is itself named servers', async () => {
    // A flat entry carries a type and a nested map does not, so the two are
    // told apart by the type.
    const path = await configFile(`{
  "mcp": {
    "servers": { "type": "local", "command": ["servers"] }
  }
}
`);

    const { servers, notes } = globalMcpServers(path);

    expect(servers).toEqual({ servers: { type: 'local', command: ['servers'] } });
    expect(notes).toEqual([]);
  });

  it('drops the environment, so a key is not written into a case directory', async () => {
    const path = await configFile(
      JSON.stringify({
        mcp: {
          exa: {
            type: 'remote',
            url: 'https://mcp.exa.ai/mcp',
            environment: { EXA_API_KEY: 'secret' },
          },
        },
      }),
    );

    const { servers } = globalMcpServers(path);

    expect(servers.exa).toEqual({ type: 'remote', url: 'https://mcp.exa.ai/mcp' });
  });

  it('has no servers when the file is missing, unreadable or has none', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oa-mcp-'));
    expect(globalMcpServers(join(dir, 'nothing-here.json'))).toEqual({ servers: {}, notes: [] });

    const path = join(dir, 'opencode.json');
    await writeFile(path, '{ "mcp": "not an object" }', 'utf8');
    expect(globalMcpServers(path)).toEqual({ servers: {}, notes: [] });
  });

  it('reports a config it could not parse, with the path and the error', async () => {
    // The measured failure (2026-10-27): a global config with a missing
    // comma. jsonc-parser does not throw on it, it returns what it could
    // parse, so the harness read a broken file as a file that said nothing
    // and the run went on into a state where every session that started
    // died.
    const path = await configFile(`{
  "mcp": {
    "verne": {
      "command": ["verne-mcp"]
      "type": "local"
    }
  }
}
`);

    const { servers, notes } = globalMcpServers(path);

    expect(servers).toEqual({});
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(path);
    expect(notes[0]).toContain('not valid JSONC');
  });

  it('reads a config with a trailing comma', async () => {
    // The machine's own config ends its list with a comma, and JSONC allows
    // it. A reader that called that an error would report a broken file
    // that is not broken.
    const path = await configFile(`{
  "mcp": {
    "github": { "type": "local", "command": ["gh", "mcp"] },
  },
}
`);

    const { servers, notes } = globalMcpServers(path);

    expect(servers.github).toEqual({ type: 'local', command: ['gh', 'mcp'] });
    expect(notes).toEqual([]);
  });
});

describe('caseMcp', () => {
  it('writes one disabled entry per global server, in the shape the runtime reads', async () => {
    const home = await mkdtemp(join(tmpdir(), 'oa-home-'));
    await mkdir(join(home, '.opencode'), { recursive: true });
    await writeFile(
      join(home, '.opencode', 'opencode.jsonc'),
      `{
  "mcp": {
    "github": { "type": "local", "command": ["gh", "mcp"] },
    "servers": { "exa": { "type": "remote", "url": "https://mcp.exa.ai/mcp" } }
  }
}
`,
      'utf8',
    );

    const before = process.env.HOME;
    process.env.HOME = home;
    try {
      // OpenCode 1 reads a flat map and switches a server off with
      // "enabled": false.
      expect(caseMcp(V1).mcp).toEqual({
        github: { type: 'local', command: ['gh', 'mcp'], enabled: false },
        exa: { type: 'remote', url: 'https://mcp.exa.ai/mcp', enabled: false },
      });
      // OpenCode 2 nests the map under "servers" and switches a server off
      // with "disabled": true.
      expect(caseMcp(V2).mcp).toEqual({
        servers: {
          github: { type: 'local', command: ['gh', 'mcp'], disabled: true },
          exa: { type: 'remote', url: 'https://mcp.exa.ai/mcp', disabled: true },
        },
      });
    } finally {
      if (before === undefined) delete process.env.HOME;
      else process.env.HOME = before;
    }
  });

  it('never writes an entry the server would ignore', async () => {
    const home = await mkdtemp(join(tmpdir(), 'oa-home-'));
    await mkdir(join(home, '.config', 'opencode'), { recursive: true });
    await writeFile(
      join(home, '.config', 'opencode', 'opencode.jsonc'),
      `{
  "mcp": {
    "servers": {
      "github": { "type": "local", "command": ["gh", "mcp"] }
    }
  }
}
`,
      'utf8',
    );

    const before = process.env.HOME;
    process.env.HOME = home;
    try {
      const flat = caseMcp(V1).mcp;
      expect(Object.keys(flat)).toEqual(['github']);
      expect(flat.github).toHaveProperty('type');

      const nested = caseMcp(V2).mcp.servers as Record<string, unknown>;
      expect(Object.keys(nested)).toEqual(['github']);
      expect(nested.github).toHaveProperty('type');
    } finally {
      if (before === undefined) delete process.env.HOME;
      else process.env.HOME = before;
    }
  });
});
