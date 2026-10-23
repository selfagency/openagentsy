import { beforeEach, describe, expect, it } from 'vitest';
import type { BoardDatabase } from './db.js';
import { migrate, openDatabase } from './db.js';
import {
  checkLease,
  grantLeases,
  listLeases,
  releaseLease,
  revokeLease,
  writerCount,
} from './leases.js';

let db: BoardDatabase;

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

  it('prefers a literal path over a wildcard of the same length', () => {
    // The length of the pattern was the whole rule, so two globs of the
    // same length could rank either way. A literal names a file, and a
    // wildcard names a shape.
    grantLeases(db, { bean: 'proj-42', agent: 'builder-1', globs: ['src/a*.ts'] });
    grantLeases(db, { bean: 'proj-43', agent: 'builder-2', globs: ['src/ab.ts'] });
    const decision = checkLease(db, { path: '/repo/src/ab.ts', root: ROOT });
    expect(decision.agent).toBe('builder-2');
  });

  it('prefers a single star over a double one', () => {
    grantLeases(db, { bean: 'proj-42', agent: 'builder-1', globs: ['src/**'] });
    grantLeases(db, { bean: 'proj-43', agent: 'builder-2', globs: ['src/*'] });
    const decision = checkLease(db, { path: '/repo/src/x.ts', root: ROOT });
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

  it('counts one writer for two spellings of the same name', () => {
    grantLeases(db, { bean: 'proj-42', agent: 'Builder-1', globs: ['src/**'] });
    grantLeases(db, { bean: 'proj-42', agent: 'builder-1', globs: ['web/**'] });
    expect(writerCount(db)).toBe(1);
  });

  it('lets a writer take another lease under a different spelling of its name', () => {
    for (const agent of ['builder-1', 'builder-2', 'builder-3']) {
      grantLeases(db, { bean: 'proj-42', agent, globs: [`${agent}/**`] });
    }
    const result = grantLeases(
      db,
      { bean: 'proj-42', agent: 'Builder-2', globs: ['builder-2/more/**'] },
      { writerCap: 3 },
    );
    expect(result.granted).toHaveLength(1);
    expect(result.capReached).toBeUndefined();
  });
});

describe('grantLeases', () => {
  it('says so when the agent already holds the glob', () => {
    // A grant of a glob the agent holds is not a new lease, and an empty
    // result reads like a refusal.
    grantLeases(db, { bean: 'proj-42', agent: 'builder-1', globs: ['src/**'] });
    const second = grantLeases(db, {
      bean: 'proj-42',
      agent: 'builder-1',
      globs: ['src/**'],
    });
    expect(second.granted).toHaveLength(0);
    expect(second.alreadyHeld).toHaveLength(1);
    expect(second.alreadyHeld[0]?.glob).toBe('src/**');
  });

  it('moves the lease to the new bean when the plan changes', () => {
    // The bean is what the lease is attributed to. A silent no-op would
    // leave the board pointing at the old plan.
    grantLeases(db, { bean: 'proj-42', agent: 'builder-1', globs: ['src/**'] });
    const second = grantLeases(db, {
      bean: 'proj-43',
      agent: 'builder-1',
      globs: ['src/**'],
    });
    expect(second.granted).toHaveLength(1);
    expect(second.granted[0]?.bean).toBe('proj-43');
    expect(listLeases(db)).toHaveLength(1);
    expect(listLeases(db)[0]?.bean).toBe('proj-43');
  });
});

describe('revokeLease', () => {
  it('takes the lease away from the agent that holds it', () => {
    grantLeases(db, { bean: 'proj-42', agent: 'builder-1', globs: ['src/**'] });
    const result = revokeLease(db, { glob: 'src/**' });
    expect(result.revoked).toBe(true);
    expect(result.lease?.agent).toBe('builder-1');
    expect(listLeases(db)).toHaveLength(0);
  });

  it('says so when there is no lease to take back', () => {
    expect(revokeLease(db, { glob: 'nothing/**' }).revoked).toBe(false);
  });

  it('frees the writer for another agent', () => {
    // Three dead sessions holding a lease would put the board over the
    // writer cap for good, and the cap is enforced in the board.
    grantLeases(db, { bean: 'proj-42', agent: 'builder-1', globs: ['src/**'] });
    revokeLease(db, { glob: 'src/**' });
    const granted = grantLeases(db, {
      bean: 'proj-43',
      agent: 'builder-2',
      globs: ['src/**'],
    });
    expect(granted.granted).toHaveLength(1);
  });
});

describe('releaseLease', () => {
  it('gives the lease back', () => {
    grantLeases(db, { bean: 'proj-42', agent: 'builder-1', globs: ['src/**'] });
    const result = releaseLease(db, {
      bean: 'proj-42',
      agent: 'builder-1',
      glob: 'src/**',
    });
    expect(result.released).toBe(true);
    expect(listLeases(db)).toHaveLength(0);
  });

  it('gives the lease back under a different spelling of the holder name', () => {
    grantLeases(db, { bean: 'proj-42', agent: 'Builder-1', globs: ['src/**'] });
    const result = releaseLease(db, {
      bean: 'proj-42',
      agent: 'builder-1',
      glob: 'src/**',
    });
    expect(result.released).toBe(true);
    expect(listLeases(db)).toHaveLength(0);
  });

  it('refuses to release a lease another agent holds', () => {
    grantLeases(db, { bean: 'proj-42', agent: 'builder-1', globs: ['src/**'] });
    const result = releaseLease(db, {
      bean: 'proj-42',
      agent: 'builder-2',
      glob: 'src/**',
    });
    expect(result.released).toBe(false);
    expect(listLeases(db)).toHaveLength(1);
  });

  it('refuses to release a lease another bean holds', () => {
    grantLeases(db, { bean: 'proj-42', agent: 'builder-1', globs: ['src/**'] });
    const result = releaseLease(db, {
      bean: 'proj-43',
      agent: 'builder-1',
      glob: 'src/**',
    });
    expect(result.released).toBe(false);
    expect(listLeases(db)).toHaveLength(1);
  });
});
