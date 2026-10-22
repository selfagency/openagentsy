import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bean TEXT NOT NULL,
  kind TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  to_agent TEXT,
  action TEXT NOT NULL,
  state TEXT NOT NULL,
  artifact TEXT,
  contract TEXT,
  needs TEXT,
  surprise TEXT,
  confidence TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS records_inbox ON records (to_agent, id);
CREATE INDEX IF NOT EXISTS records_bean ON records (bean, id);

CREATE TABLE IF NOT EXISTS record_reads (
  record_id INTEGER NOT NULL,
  agent TEXT NOT NULL,
  read_at TEXT NOT NULL,
  PRIMARY KEY (record_id, agent)
);

CREATE TABLE IF NOT EXISTS leases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bean TEXT NOT NULL,
  agent TEXT NOT NULL,
  glob TEXT NOT NULL,
  granted_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS leases_agent_glob ON leases (agent, glob);

CREATE TABLE IF NOT EXISTS budgets (
  bean TEXT PRIMARY KEY,
  token_limit INTEGER NOT NULL,
  stop_at INTEGER NOT NULL,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
`;

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

export function migrate(db: DatabaseSync): void {
  db.exec(SCHEMA);
}
