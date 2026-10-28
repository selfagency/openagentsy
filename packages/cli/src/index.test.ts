import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BENCHLM_KEYLESS_URL,
  LOCK_FILE_NAME,
  MODELS_DEV_URL,
  OLLAMA_CLOUD_URL,
} from '@openagentsy/models';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runModels } from './commands/models.js';
import { main } from './index.js';

let root: string;
let written: string[];

const ROLES_YAML = `version: 1
roles:
  builder:
    description: Writes the code.
    mode: subagent
    writes: true
    scope: Write the code.
    guidance: Write the code.
    permissions: {}
    skills: []
    modelProfile:
      primarySignal: coding
      hardRequirements: [tool_calls]
      costStance: quality_first
    effort:
      startVariant: medium
      ceilingVariant: high
      climbTriggers: []
`;

function modelMeta(id: string, name: string): Record<string, unknown> {
  return {
    id,
    name,
    tool_call: true,
    reasoning: true,
    reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
    limit: { context: 200_000 },
    cost: { input: 1, output: 3 },
  };
}

const MODELS_DEV = {
  'ollama-cloud': {
    id: 'ollama-cloud',
    models: {
      'glm-5.3': modelMeta('glm-5.3', 'GLM 5.3'),
      'glm-5.3-flash': modelMeta('glm-5.3-flash', 'GLM 5.3 Flash'),
    },
  },
  ollama: {
    id: 'ollama',
    models: {
      'local-model': modelMeta('local-model', 'Local Model'),
    },
  },
};

function benchItem(slug: string, model: string, rank: number) {
  return {
    rank,
    slug,
    canonicalModelKey: slug,
    model,
    creator: 'Test Creator',
    displayScore: 100 - rank,
    evidenceStatus: 'supported' as const,
    scoreConfidence: 3,
    overallRank: rank,
    rankingEligible: true,
  };
}

const BENCHLM = {
  generatedAt: '2026-10-24T00:00:00.000Z',
  items: [
    benchItem('glm-5-3', 'GLM 5.3', 1),
    benchItem('glm-5-3-flash', 'GLM 5.3 Flash', 2),
    benchItem('local-model', 'Local Model', 3),
  ],
  categories: {
    coding: [
      benchItem('glm-5-3', 'GLM 5.3', 1),
      benchItem('glm-5-3-flash', 'GLM 5.3 Flash', 2),
      benchItem('local-model', 'Local Model', 3),
    ],
  },
};

const CLOUD_TAGS = { models: [{ name: 'glm-5.3' }, { name: 'glm-5.3-flash' }] };
const LOCAL_TAGS = { models: [{ name: 'local-model' }] };

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** The catalogs the selector reads, served without a network. */
function fakeFetch(url: string): Promise<Response> {
  if (url === MODELS_DEV_URL) return Promise.resolve(json(MODELS_DEV));
  if (url === BENCHLM_KEYLESS_URL) return Promise.resolve(json(BENCHLM));
  if (url === `${OLLAMA_CLOUD_URL}/api/tags`) return Promise.resolve(json(CLOUD_TAGS));
  if (url === 'http://localhost:11434/api/tags') return Promise.resolve(json(LOCAL_TAGS));
  return Promise.reject(new Error(`the test does not serve ${url}`));
}

async function lockOnDisk(): Promise<{
  providers?: string[];
  roles: Record<string, { model: string }>;
}> {
  return JSON.parse(await readFile(join(root, LOCK_FILE_NAME), 'utf8'));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openagentsy-cli-'));
  written = [];
  await writeFile(join(root, 'roles.yaml'), ROLES_YAML);
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('the CLI', () => {
  it('prints the usage and fails when no command is given', async () => {
    const code = await main([]);
    expect(code).toBe(1);
    expect(written.join('')).toContain('openagentsy <command>');
  });

  it('prints the usage on --help and succeeds', async () => {
    const code = await main(['--help']);
    expect(code).toBe(0);
    expect(written.join('')).toContain('board');
  });

  it('says so when the command is unknown', async () => {
    const code = await main(['nope']);
    expect(code).toBe(1);
  });

  it('shows the board, which is empty on a fresh root', async () => {
    const code = await main(['board', '--root', root]);
    expect(code).toBe(0);
    const output = written.join('');
    expect(output).toContain('records');
    expect(output).toContain('leases');
    expect(output).toContain('budgets');
  });

  it('writes nothing on a dry run of setup', async () => {
    const code = await main(['setup', '--root', root, '--dry-run']);
    expect(code).toBe(0);
    expect(written.join('')).toContain('would write');
  });

  it('leaves the compaction alone by default', async () => {
    // Compaction is off for a memory integration that shrinks the context
    // itself. There is no such integration yet, so a default install that
    // turns compaction off grows a long session without a bound.
    const code = await main(['setup', '--root', root, '--dry-run']);
    expect(code).toBe(0);
    expect(written.join('')).not.toContain('compaction');
  });

  it('turns the compaction off for a memory integration', async () => {
    const code = await main(['setup', '--root', root, '--dry-run', '--magic-context']);
    expect(code).toBe(0);
    expect(written.join('')).toContain('compaction.auto');
  });
});

describe('the models command', () => {
  it('writes the lock when a switch names a provider', async () => {
    const result = await runModels({
      workspace: root,
      stateRoot: root,
      mode: 'switch',
      providers: ['ollama'],
      yes: true,
      fetchImpl: fakeFetch,
    });
    expect(result.written).toBe(true);
    const lock = await lockOnDisk();
    expect(lock.providers).toEqual(['ollama-cloud']);
    expect(lock.roles.builder?.model).toBe('ollama-cloud/glm-5.3');
  });

  it('resolves the alias ollama to the cloud provider', async () => {
    const result = await runModels({
      workspace: root,
      stateRoot: root,
      mode: 'switch',
      providers: ['ollama'],
      yes: true,
      fetchImpl: fakeFetch,
    });
    expect(result.providers).toEqual(['ollama-cloud']);
  });

  it('keeps the providers the lock records when it refreshes', async () => {
    await writeFile(
      join(root, LOCK_FILE_NAME),
      JSON.stringify({
        generatedAt: '2026-10-24T00:00:00.000Z',
        providers: ['ollama'],
        roles: { builder: { model: 'ollama/local-model', ladder: [] } },
      }),
    );
    const result = await runModels({
      workspace: root,
      stateRoot: root,
      mode: 'refresh',
      providers: [],
      yes: true,
      fetchImpl: fakeFetch,
    });
    expect(result.providers).toEqual(['ollama']);
    const lock = await lockOnDisk();
    expect(lock.providers).toEqual(['ollama']);
    expect(lock.roles.builder?.model).toBe('ollama/local-model');
  });

  it('takes the flash variant when the preference is asked for', async () => {
    const result = await runModels({
      workspace: root,
      stateRoot: root,
      mode: 'switch',
      providers: ['ollama'],
      preferFlash: true,
      yes: true,
      fetchImpl: fakeFetch,
    });
    expect(result.lock.roles.builder?.model).toBe('ollama-cloud/glm-5.3-flash');
    expect(result.changes[0]?.note).toContain('flash variant of glm-5.3');
  });

  it('names the aliases and what each one means when a provider is unknown', async () => {
    await expect(main(['models', 'init', '--providers', 'nope', '--root', root])).rejects.toThrow(
      /ollama = the Ollama Cloud models/,
    );
  });

  it('says what the switch touches besides the lock', async () => {
    const code = await main(['models', 'switch', 'ollama', '--yes', '--root', root]);
    expect(code).toBe(0);
    const output = written.join('');
    expect(output).toContain('the switch touches more than the lock');
    expect(output).toContain('openagentsy build');
    expect(output).toContain('OLLAMA_API_KEY');
  });
});
