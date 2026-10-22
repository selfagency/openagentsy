import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  grantLeases,
  type Lease,
  listLeases,
  migrate,
  openDatabase,
  writeLeaseSnapshot,
} from '@openagentsy/core';

const execFileAsync = promisify(execFile);

export type Fixture = {
  /** Files to write, keyed by path relative to the case directory. */
  files: Record<string, string>;
  /** Leases to grant, relative globs. */
  leases?: { agent: string; glob: string; bean?: string }[];
  /** The model the agent under test runs on. */
  model?: string;
};

export type CaseState = {
  root: string;
  leases: Lease[];
  auditPath: string;
  boardPath: string;
};

/**
 * Seed a case directory.
 *
 * The directory gets the agents, the plugin and the board, so the case runs
 * against the same wiring a real project has.
 */
export async function seedCase(
  root: string,
  fixture: Fixture,
  _options: { repoRoot: string },
): Promise<CaseState> {
  for (const [path, content] of Object.entries(fixture.files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }

  await execFileAsync('git', ['init', '-q'], { cwd: root });
  await execFileAsync('git', ['add', '-A'], { cwd: root });
  await execFileAsync(
    'git',
    [
      '-c',
      'user.email=eval@openagentsy.test',
      '-c',
      'user.name=eval',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '-m',
      'seed',
    ],
    { cwd: root },
  );

  const stateDir = join(root, '.openagentsy');
  await mkdir(stateDir, { recursive: true });

  const db = openDatabase(join(stateDir, 'board.sqlite'));
  migrate(db);
  for (const lease of fixture.leases ?? []) {
    grantLeases(db, {
      bean: lease.bean ?? 'eval-1',
      agent: lease.agent,
      globs: [lease.glob],
    });
  }
  const leases = listLeases(db);
  await writeLeaseSnapshot(join(stateDir, 'leases.json'), leases);
  db.close();

  return {
    root,
    leases,
    auditPath: join(stateDir, 'audit.jsonl'),
    boardPath: join(stateDir, 'board.sqlite'),
  };
}

/** The files a case may write, so the assertions can tell what changed. */
export async function readAudit(
  state: CaseState,
): Promise<
  { policyId: string; actor: string; action: string; resource: string; effect: string }[]
> {
  const { readFile } = await import('node:fs/promises');
  let text: string;
  try {
    text = await readFile(state.auditPath, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as never);
}

/** Every record the board holds, for the assertions on what an agent reported. */
export async function readRecords(
  state: CaseState,
): Promise<{ kind: string; from: string; bean: string; action: string; state: string }[]> {
  const db = openDatabase(state.boardPath);
  try {
    const rows = db
      .prepare(`SELECT kind, from_agent, bean, action, state FROM records ORDER BY id`)
      .all() as unknown as {
      kind: string;
      from_agent: string;
      bean: string;
      action: string;
      state: string;
    }[];
    return rows.map((row) => ({
      kind: row.kind,
      from: row.from_agent,
      bean: row.bean,
      action: row.action,
      state: row.state,
    }));
  } finally {
    db.close();
  }
}
