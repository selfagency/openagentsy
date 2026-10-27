import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, createRecord, migrate, openDatabase } from '@openagentsy/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBridge, type HostConfig } from './bridge.js';
import type { ClientLike } from './client.js';
import plugin from './index.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openagentsy-bridge-'));
  await mkdir(join(root, '.openagentsy'), { recursive: true });
});

/** The tool call a host hands over. */
function call(tool: string) {
  return { tool, sessionID: 'ses-1', callID: 'call-1' };
}

describe('the bridge', () => {
  it('stops a built-in call that trips a rule, and the reason reaches the model', async () => {
    const bridge = createBridge({ workspace: root, stateRoot: root });
    const output = { args: { filePath: 'roles.yaml', content: 'version: 1' } };

    await expect(bridge['tool.execute.before'](call('write'), output)).rejects.toThrow(
      /changed by a person/,
    );
  });

  it('stops a shell call that skips the hooks', async () => {
    const bridge = createBridge({ workspace: root, stateRoot: root });
    const output = { args: { command: 'git commit -n -m "wip"' } };

    await expect(bridge['tool.execute.before'](call('bash'), output)).rejects.toThrow(/Git hooks/);
  });

  it('lets a call that trips nothing through', async () => {
    const bridge = createBridge({ workspace: root, stateRoot: root });
    const output = { args: { command: 'ls -la' } };

    await expect(bridge['tool.execute.before'](call('bash'), output)).resolves.toBeUndefined();
  });

  it('reads the files of a patch, so a patch onto a protected path is stopped', async () => {
    const bridge = createBridge({ workspace: root, stateRoot: root });
    const patchText = [
      '*** Begin Patch',
      '*** Update File: src/app.ts',
      '*** Move to: roles.yaml',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n');

    await expect(
      bridge['tool.execute.before'](call('apply_patch'), { args: { patchText } }),
    ).rejects.toThrow(/changed by a person/);
  });

  it('resolves a prefixed tool name to its base name before the rules read it', async () => {
    const bridge = createBridge({
      workspace: root,
      stateRoot: root,
      rules: [
        {
          id: 'no-board-record',
          event: 'PreToolCall',
          block: true,
          handler: (event) => {
            const tool = (event as { toolName?: unknown }).toolName;
            return tool === 'board_record'
              ? { continue: false, reason: 'the board is not written from here' }
              : { continue: true };
          },
        },
      ],
    });

    await expect(
      bridge['tool.execute.before'](call('openagentsy-board_board_record'), { args: {} }),
    ).rejects.toThrow(/the board is not written from here/);
  });

  it('stops the human-only tools under their prefixed names too', async () => {
    const bridge = createBridge({ workspace: root, stateRoot: root });

    await expect(
      bridge['tool.execute.before'](call('openagentsy-memory_oa_memory_decide'), { args: {} }),
    ).rejects.toThrow(/recorded by a person/);
  });

  it('mutates the arguments in place, and the host gets the same object back', async () => {
    const bridge = createBridge({
      workspace: root,
      stateRoot: root,
      rules: [
        {
          id: 'rewrite',
          event: 'PreToolCall',
          handler: () => ({ transform: { content: 'rewritten' } }),
        },
      ],
    });
    const args = { filePath: 'src/app.ts', content: 'original' };
    const output = { args };

    await bridge['tool.execute.before'](call('write'), output);

    expect(output.args).toBe(args);
    expect(args['content']).toBe('rewritten');
  });

  it('takes the switches and the keys out of the shell environment', async () => {
    const bridge = createBridge({ workspace: root, stateRoot: root });
    const env: Record<string, string> = {
      HUSKY: '0',
      TYPESAFE_API_KEY: 'secret',
      PATH: '/usr/bin',
    };

    await bridge['shell.env']({ cwd: root }, { env });

    expect(env['HUSKY']).toBeUndefined();
    expect(env['TYPESAFE_API_KEY']).toBeUndefined();
    expect(env['TURBO_TELEMETRY_DISABLED']).toBe('1');
    expect(env['OPENAGENTSY_AGENT']).toBe('1');
    expect(env['PATH']).toBe('/usr/bin');
  });

  it('flags a reply without stopping it', async () => {
    const findings: string[] = [];
    const bridge = createBridge({
      workspace: root,
      stateRoot: root,
      onFindings: (found) => {
        findings.push(...found.map((finding) => finding.name));
      },
    });
    const output = { text: "You're absolutely right, that is a great idea." };

    await expect(
      bridge['experimental.text.complete']({ sessionID: 'ses-1' }, output),
    ).resolves.toBeUndefined();

    expect(findings.length).toBeGreaterThan(0);
    expect(output.text).toContain('OpenAgentsy output check');
  });

  it('says nothing about a reply that trips nothing', async () => {
    const findings: string[] = [];
    const bridge = createBridge({
      workspace: root,
      stateRoot: root,
      onFindings: (found) => {
        findings.push(...found.map((finding) => finding.name));
      },
    });
    const output = { text: 'The build is green and the commit is a1b2c3.' };

    await bridge['experimental.text.complete']({ sessionID: 'ses-1' }, output);

    expect(findings).toEqual([]);
    expect(output.text).toBe('The build is green and the commit is a1b2c3.');
  });

  it('says nothing about a file in a reply when the task scope is not known', async () => {
    // A reply that names a file is not out of scope of a scope nobody
    // stated, and a check that fires on every mention says nothing.
    const findings: string[] = [];
    const bridge = createBridge({
      workspace: root,
      stateRoot: root,
      onFindings: (found) => {
        findings.push(...found.map((finding) => finding.name));
      },
    });
    const text = 'I changed packages/adapter-opencode/src/bridge.ts and the gate is green.';
    const output = { text };

    await bridge['experimental.text.complete']({ sessionID: 'ses-1' }, output);

    expect(findings).toEqual([]);
    expect(output.text).toBe(text);
  });

  it('flags a file the stated scope does not cover', async () => {
    const findings: string[] = [];
    const bridge = createBridge({
      workspace: root,
      stateRoot: root,
      statedPaths: ['packages/core/src/board.ts'],
      onFindings: (found) => {
        findings.push(...found.map((finding) => finding.name));
      },
    });
    const output = {
      text: 'I changed packages/adapter-opencode/src/bridge.ts and the gate is green.',
    };

    await bridge['experimental.text.complete']({ sessionID: 'ses-1' }, output);

    expect(findings).toContain('scope-drift');
  });

  it('asks the caller for the scope of a session, per reply', async () => {
    // The scope of a task is a fact of the board, and the board changes
    // while a session runs, so the paths are asked for per reply.
    const asked: string[] = [];
    const findings: string[] = [];
    let scope: string[] = [];
    const bridge = createBridge({
      workspace: root,
      stateRoot: root,
      statedPathsForSession: (sessionID) => {
        asked.push(sessionID);
        return scope;
      },
      onFindings: (found) => {
        findings.push(...found.map((finding) => finding.name));
      },
    });

    await bridge['experimental.text.complete'](
      { sessionID: 'ses-1' },
      { text: 'I changed packages/adapter-opencode/src/bridge.ts and the gate is green.' },
    );
    expect(asked).toEqual(['ses-1']);
    expect(findings).toEqual([]);

    scope = ['packages/core/src/board.ts'];
    await bridge['experimental.text.complete'](
      { sessionID: 'ses-1' },
      { text: 'I changed packages/adapter-opencode/src/bridge.ts and the gate is green.' },
    );
    expect(findings).toContain('scope-drift');
  });

  it('merges the approval list into the permission config', async () => {
    const bridge = createBridge({
      workspace: root,
      stateRoot: root,
      approvalFor: ['git push'],
    });
    const config: HostConfig = { permission: { bash: { 'git push*': 'allow' } } };

    await bridge.config(config);

    expect(config.permission?.['bash']).toEqual({ 'git push*': 'ask' });
  });

  it('refuses a merge that would loosen a permission, and keeps the tighter one', async () => {
    const refusals: Error[] = [];
    const bridge = createBridge({
      workspace: root,
      stateRoot: root,
      approvalFor: ['git push'],
      onPermissionRefusal: (error) => {
        refusals.push(error);
      },
    });
    const config: HostConfig = { permission: { bash: { 'git push*': 'deny' } } };

    await bridge.config(config);

    expect(refusals).toHaveLength(1);
    expect(config.permission?.['bash']).toEqual({ 'git push*': 'deny' });
  });
});

/** A client that answers with one session's messages. */
function fakeClient(messages: { parts?: { type: string; text?: string }[] }[]): ClientLike {
  return {
    provider: { list: async () => ({ data: { all: [] } }) },
    session: {
      create: async () => ({ data: {} }),
      get: async () => ({ data: {} }),
      list: async () => ({ data: [] }),
      delete: async () => ({ data: true }),
      messages: async () => ({ data: messages }),
      promptAsync: async () => undefined,
    },
  };
}

describe('the idle path', () => {
  it('says nothing about a file in a reply through the shipped hook', async () => {
    // The review's own case, through the plugin: no finding, no annotation
    // and no audit row.
    const client = fakeClient([]);
    const hooks = await plugin.server({ client, directory: root, worktree: '' });
    const text = 'I changed packages/adapter-opencode/src/bridge.ts and the gate is green.';
    const output = { text };

    await hooks['experimental.text.complete']?.({ sessionID: 'ses-1' }, output);

    expect(output.text).toBe(text);
    const audit = await readFile(join(root, '.openagentsy', 'audit.jsonl'), 'utf8').catch(() => '');
    expect(audit).not.toContain('scope-drift');
  });
  it('records a report that contradicts the board', async () => {
    await writeFile(join(root, '.openagentsy', 'harvest'), 'off', 'utf8');
    const db = openDatabase(join(root, '.openagentsy', 'board.sqlite'));
    migrate(db);
    createRecord(db, {
      bean: '2c-2',
      kind: 'status',
      from: 'agentsy',
      action: 'the round is over',
      state: 'complete',
      confidence: 'verified',
    });
    closeDatabase(db);

    const client = fakeClient([
      { parts: [{ type: 'text', text: 'The round status is running.' }] },
    ]);
    const hooks = await plugin.server({ client, directory: root, worktree: '' });
    await hooks['chat.params']?.({ sessionID: 'ses-1', agent: 'agentsy' }, { options: {} });

    await hooks.event?.({
      event: { type: 'session.idle', properties: { sessionID: 'ses-1' } },
    });

    const audit = await readFile(join(root, '.openagentsy', 'audit.jsonl'), 'utf8');
    expect(audit).toContain('oa.round.status');
    expect(audit).toContain('complete');
  });

  it('keeps the session alive when the idle path throws', async () => {
    // The `event` hook is not awaited by OpenCode, so a throw there is a
    // broken session and not a failed check. A rung file that cannot be
    // written makes the idle path throw.
    await writeFile(join(root, '.openagentsy', 'harvest'), 'off', 'utf8');
    const rungs = join(root, '.openagentsy', 'rungs.json');
    await writeFile(
      rungs,
      JSON.stringify({ 'ses-1': { role: 'lead', rungIndex: 0, reason: 'x', updatedAt: 'now' } }),
      'utf8',
    );
    await chmod(rungs, 0o400);
    const db = openDatabase(join(root, '.openagentsy', 'board.sqlite'));
    migrate(db);
    closeDatabase(db);

    const client = fakeClient([{ parts: [{ type: 'text', text: 'The round is over.' }] }]);
    const hooks = await plugin.server({ client, directory: root, worktree: '' });
    await hooks['chat.params']?.({ sessionID: 'ses-1', agent: 'agentsy' }, { options: {} });

    await expect(
      hooks.event?.({ event: { type: 'session.idle', properties: { sessionID: 'ses-1' } } }),
    ).resolves.toBeUndefined();

    const audit = await readFile(join(root, '.openagentsy', 'audit.jsonl'), 'utf8');
    expect(audit).toContain('oa.events.failed');
  });
});
