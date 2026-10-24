import * as t from 'drizzle-orm/sqlite-core';

/**
 * The board's tables, declared in drizzle.
 *
 * This file imports only the schema builder, no driver, so `drizzle-kit
 * generate` can load it under node. The driver wiring lives in `db.ts`.
 *
 * The board is the one thing every agent talks through, so its tables are
 * small and its queries are typed end to end.
 */

export const records = t.sqliteTable(
  'records',
  {
    id: t.integer('id').primaryKey({ autoIncrement: true }),
    bean: t.text('bean').notNull(),
    kind: t.text('kind').notNull(),
    fromAgent: t.text('from_agent').notNull(),
    toAgent: t.text('to_agent'),
    action: t.text('action').notNull(),
    state: t.text('state').notNull(),
    artifact: t.text('artifact'),
    contract: t.text('contract'),
    needs: t.text('needs'),
    surprise: t.text('surprise'),
    confidence: t.text('confidence').notNull(),
    createdAt: t.text('created_at').notNull(),
  },
  (table) => [
    t.index('records_inbox').on(table.toAgent, table.id),
    t.index('records_bean').on(table.bean, table.id),
  ],
);

export const recordReads = t.sqliteTable(
  'record_reads',
  {
    recordId: t.integer('record_id').notNull(),
    agent: t.text('agent').notNull(),
    readAt: t.text('read_at').notNull(),
  },
  (table) => [t.primaryKey({ columns: [table.recordId, table.agent] })],
);

export const leases = t.sqliteTable(
  'leases',
  {
    id: t.integer('id').primaryKey({ autoIncrement: true }),
    bean: t.text('bean').notNull(),
    agent: t.text('agent').notNull(),
    glob: t.text('glob').notNull(),
    grantedAt: t.text('granted_at').notNull(),
  },
  (table) => [t.uniqueIndex('leases_agent_glob').on(table.agent, table.glob)],
);

export const budgets = t.sqliteTable('budgets', {
  bean: t.text('bean').primaryKey(),
  tokenLimit: t.integer('token_limit').notNull(),
  stopAt: t.integer('stop_at').notNull(),
  tokensUsed: t.integer('tokens_used').notNull().default(0),
  updatedAt: t.text('updated_at').notNull(),
});
