import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase } from './db.js';
import { BoardError, createRecord, listRecords } from './records.js';
import type { PostRecordInput } from './types.js';

let db: DatabaseSync;

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
});

function input(overrides: Partial<PostRecordInput> = {}): PostRecordInput {
  return {
    bean: 'proj-42',
    kind: 'status',
    from: 'builder-2',
    action: 'Added the search handler',
    state: 'tests: 14/14 pass',
    confidence: 'verified',
    ...overrides,
  };
}

describe('createRecord', () => {
  it('stores every field of the record', () => {
    const record = createRecord(
      db,
      input({
        to: 'lead',
        artifact: 'commit a1b2c3',
        contract: { 'GET /search': '-> [{id}]' },
        needs: 'frontend consumes it',
        surprise: 'the index had no title column',
      }),
    );
    expect(record.bean).toBe('proj-42');
    expect(record.kind).toBe('status');
    expect(record.to).toBe('lead');
    expect(record.artifact).toBe('commit a1b2c3');
    expect(record.contract).toEqual({ 'GET /search': '-> [{id}]' });
    expect(record.needs).toBe('frontend consumes it');
    expect(record.surprise).toBe('the index had no title column');
  });

  it('rejects an unknown kind and says what to use instead', () => {
    try {
      createRecord(db, input({ kind: 'gossip' as PostRecordInput['kind'] }));
      throw new Error('expected a BoardError');
    } catch (error) {
      expect(error).toBeInstanceOf(BoardError);
      expect((error as BoardError).hint).toContain('status');
    }
  });

  it('rejects an unknown confidence', () => {
    expect(() =>
      createRecord(db, input({ confidence: 'pretty sure' as PostRecordInput['confidence'] })),
    ).toThrow(BoardError);
  });
});

describe('listRecords', () => {
  it('returns a broadcast record to every agent', () => {
    createRecord(db, input());
    const result = listRecords(db, { agent: 'lead' });
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.action).toBe('Added the search handler');
  });

  it('returns a record addressed to another agent only to that agent', () => {
    createRecord(db, input({ to: 'lead' }));
    expect(listRecords(db, { agent: 'lead' }).records).toHaveLength(1);
    expect(listRecords(db, { agent: 'builder-2' }).records).toHaveLength(0);
  });

  it('marks records read for the agent that fetched them', () => {
    createRecord(db, input());
    listRecords(db, { agent: 'lead' });
    expect(listRecords(db, { agent: 'lead' }).records).toHaveLength(0);
  });

  it('keeps read state per agent', () => {
    createRecord(db, input());
    listRecords(db, { agent: 'lead' });
    expect(listRecords(db, { agent: 'builder-2' }).records).toHaveLength(1);
  });

  it('leaves records unread when asked to', () => {
    createRecord(db, input());
    listRecords(db, { agent: 'lead', markRead: false });
    expect(listRecords(db, { agent: 'lead' }).records).toHaveLength(1);
  });

  it('pages with a cursor and never returns the whole board', () => {
    createRecord(db, input({ action: 'one' }));
    createRecord(db, input({ action: 'two' }));
    const first = listRecords(db, { agent: 'lead', limit: 1 });
    expect(first.records).toHaveLength(1);
    expect(first.nextCursor).toBe(first.records[0]?.id);

    const second = listRecords(db, { agent: 'lead', cursor: first.nextCursor });
    expect(second.records).toHaveLength(1);
    expect(second.records[0]?.action).toBe('two');
  });

  it('counts the unread records', () => {
    createRecord(db, input());
    createRecord(db, input());
    expect(listRecords(db, { agent: 'lead', markRead: false }).unread).toBe(2);
  });

  it('keeps the record order', () => {
    createRecord(db, input({ action: 'first' }));
    createRecord(db, input({ action: 'second' }));
    const result = listRecords(db, { agent: 'lead' });
    expect(result.records.map((record) => record.action)).toEqual(['first', 'second']);
  });
});
