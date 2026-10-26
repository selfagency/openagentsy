import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUSY_RETRIES, closeLedger, isBusyError, openLedger, withBusyRetry } from './db.js';
import { applySchema } from './schema.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openagentsy-ledger-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const INSERT = `INSERT INTO usage (message_id, session_id, root_session_id, provider, model, ts)
  VALUES ('msg_lock','ses','root','p','m','2026-10-26T00:00:00.000Z')`;

describe('the ledger schema', () => {
  it('holds the six tables of the plan', () => {
    const db = openLedger(root);
    try {
      const tables = db
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[];
      expect(tables.map((row) => row.name).sort()).toEqual([
        'footprint',
        'outcome',
        'policy_firing',
        'safety_metric',
        'usage',
        'waste',
      ]);
    } finally {
      closeLedger(db);
    }
  });

  it('is the same after it is applied twice', () => {
    const db = openLedger(root);
    try {
      const read = () =>
        db
          .query(
            "SELECT name, sql FROM sqlite_master WHERE type IN ('table','index') ORDER BY name",
          )
          .all();
      const before = read();
      applySchema(db);
      expect(read()).toEqual(before);
    } finally {
      closeLedger(db);
    }
  });

  it('opens in WAL mode with a busy timeout', () => {
    const db = openLedger(root);
    try {
      const journal = db.query('PRAGMA journal_mode').get() as { journal_mode: string };
      expect(journal.journal_mode.toLowerCase()).toBe('wal');
      const busy = db.query('PRAGMA busy_timeout').get() as { timeout: number };
      expect(busy.timeout).toBe(250);
    } finally {
      closeLedger(db);
    }
  });
});

describe('the busy retry', () => {
  it('tries five times and then gives up', () => {
    let attempts = 0;
    expect(() =>
      withBusyRetry(() => {
        attempts += 1;
        throw new Error('SQLITE_BUSY: database is locked');
      }),
    ).toThrow(/SQLITE_BUSY/);
    expect(attempts).toBe(BUSY_RETRIES + 1);
  });

  it('returns the value of the first attempt that works', () => {
    let attempts = 0;
    const value = withBusyRetry(() => {
      attempts += 1;
      if (attempts < 3) throw new Error('database is locked');
      return 'written';
    });
    expect(value).toBe('written');
    expect(attempts).toBe(3);
  });

  it('does not retry an error that is not a busy one', () => {
    let attempts = 0;
    expect(() =>
      withBusyRetry(() => {
        attempts += 1;
        throw new Error('no such table: usage');
      }),
    ).toThrow(/no such table/);
    expect(attempts).toBe(1);
  });

  it('gives up on a locked database and writes once the lock is gone', () => {
    const writer = openLedger(root);
    const other = openLedger(root);
    try {
      other.exec('PRAGMA busy_timeout = 0');
      writer.exec('BEGIN EXCLUSIVE');

      // The error has to be the busy one, and the loop has to have tried
      // again: a retry that never retries would pass a plain toThrow.
      let caught: unknown;
      let attempts = 0;
      try {
        withBusyRetry(() => {
          attempts += 1;
          return other.query(INSERT).run();
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeDefined();
      expect(isBusyError(caught)).toBe(true);
      expect(String((caught as Error).message)).toMatch(/locked|SQLITE_BUSY/);
      expect(attempts).toBeGreaterThan(1);
      expect(attempts).toBe(BUSY_RETRIES + 1);

      writer.exec('COMMIT');
      let written = 0;
      expect(() =>
        withBusyRetry(() => {
          written += 1;
          return other.query(INSERT).run();
        }),
      ).not.toThrow();
      expect(written).toBe(1);
    } finally {
      closeLedger(writer);
      closeLedger(other);
    }
  });
});
