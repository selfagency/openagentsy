import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase } from './db.js';
import { checkLease, grantLeases, listLeases, writerCount } from './leases.js';

let db: DatabaseSync;

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
});

const ROOT = '/repo';

describe('grantLeases', () => {
  it('records the globs an agent owns', () => {
    const result = grantLeases(db, { bean: 'proj-42', agent: 'builder-1', globs: ['src/api/**'] });
    expect(result.granted).toHaveLength(1);
    expect(result.conflicts).toHaveLength(0);
    expect(listLeases(db)).toEqual([
      {
        id: result.granted[0]?.id,
        bean: 'proj-42',
        agent: 'builder-1',
        glob: 'src/api/**',
        grantedAt: expect.any(String),
      },
    ]);
  });

  it('refuses a glob another agent already holds', () => {
    grantLeases(db, { bean: 'proj-42', agent: 'builder-1', globs: ['src/api/**'] });
    const result = grantLeases(db, { bean: 'proj-43', agent: 'builder-2', globs: ['src/api/**'] });
    expect(result.granted).toHaveLength(0);
    expect(result.conflicts).toEqual([{ glob: 'src/api/**', agent: 'builder-1', bean: 'proj-42' }]);
  });

  it('lets the same agent take the same glob again', () => {
    grantLeases(db, { bean: 'proj-42', agent: 'builder-1', globs: ['src/api/**'] });
    const result = grantLeases(db, { bean: 'proj-43', agent: 'builder-1', globs: ['src/api/**'] });
    expect(result.conflicts).toHaveLength(0);
  });

  it('normalises the glob before storing it', () => {
    grantLeases(db, { bean: 'proj-42', agent: 'builder-1', globs: ['./src/api/'] });
    expect(listLeases(db)[0]?.glob).toBe('src/api');
  });
});

describe('checkLease', () => {
  it('reports an unleased path', () => {
    const decision = checkLease(db, { path: '/repo/src/api/x.ts', root: ROOT });
    expect(decision.status).toBe('unleased');
  });

  it('reports the holder of a leased path', () => {
    grantLeases(db, { bean: 'proj-42', agent: 'builder-1', globs: ['src/api/**'] });
    const decision = checkLease(db, { path: '/repo/src/api/x.ts', root: ROOT, agent: 'builder-1' });
    expect(decision.status).toBe('leased');
    expect(decision.agent).toBe('builder-1');
    expect(decision.bean).toBe('proj-42');
  });

  it('reports a conflict when another agent holds the file', () => {
    grantLeases(db, { bean: 'proj-42', agent: 'builder-1', globs: ['src/api/**'] });
    const decision = checkLease(db, { path: '/repo/src/api/x.ts', root: ROOT, agent: 'builder-2' });
    expect(decision.status).toBe('conflict');
    expect(decision.agent).toBe('builder-1');
  });

  it('picks the most specific glob', () => {
    grantLeases(db, { bean: 'proj-42', agent: 'builder-1', globs: ['src/**'] });
    grantLeases(db, { bean: 'proj-43', agent: 'builder-2', globs: ['src/api/**'] });
    const decision = checkLease(db, { path: '/repo/src/api/x.ts', root: ROOT });
    expect(decision.agent).toBe('builder-2');
  });

  it('does not match a path outside the leased glob', () => {
    grantLeases(db, { bean: 'proj-42', agent: 'builder-1', globs: ['src/api/**'] });
    const decision = checkLease(db, { path: '/repo/src/web/x.ts', root: ROOT });
    expect(decision.status).toBe('unleased');
  });

  it('does not match a path outside the project root', () => {
    grantLeases(db, { bean: 'proj-42', agent: 'builder-1', globs: ['**'] });
    const decision = checkLease(db, { path: '/elsewhere/x.ts', root: ROOT });
    expect(decision.status).toBe('unleased');
  });
});

describe('the writer cap', () => {
  it('counts the agents that hold a lease', () => {
    grantLeases(db, { bean: 'proj-42', agent: 'builder-1', globs: ['src/api/**'] });
    grantLeases(db, { bean: 'proj-42', agent: 'builder-1', globs: ['src/web/**'] });
    expect(writerCount(db)).toBe(1);
    grantLeases(db, { bean: 'proj-42', agent: 'builder-2', globs: ['src/other/**'] });
    expect(writerCount(db)).toBe(2);
  });

  it('refuses a grant that would put a fourth writer on the board', () => {
    for (const agent of ['builder-1', 'builder-2', 'builder-3']) {
      const result = grantLeases(db, { bean: 'proj-42', agent, globs: [`${agent}/**`] });
      expect(result.granted).toHaveLength(1);
    }
    const result = grantLeases(
      db,
      { bean: 'proj-42', agent: 'builder-4', globs: ['builder-4/**'] },
      { writerCap: 3 },
    );
    expect(result.granted).toHaveLength(0);
    expect(result.capReached).toEqual({ writers: 3, cap: 3 });
    expect(listLeases(db)).toHaveLength(3);
  });

  it('lets a writer that already holds a lease take another', () => {
    for (const agent of ['builder-1', 'builder-2', 'builder-3']) {
      grantLeases(db, { bean: 'proj-42', agent, globs: [`${agent}/**`] });
    }
    const result = grantLeases(
      db,
      { bean: 'proj-42', agent: 'builder-2', globs: ['builder-2/more/**'] },
      { writerCap: 3 },
    );
    expect(result.granted).toHaveLength(1);
    expect(result.capReached).toBeUndefined();
  });
});
