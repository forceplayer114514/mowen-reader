import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS books (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  author        TEXT,
  cover_path    TEXT,
  file_path     TEXT NOT NULL,
  source_path   TEXT NOT NULL DEFAULT '',
  locations     TEXT,
  added_at      INTEGER NOT NULL,
  last_read_cfi TEXT,
  last_read_at  INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

export type Db = DatabaseSync

/** 打开数据库并确保表结构存在。传 ':memory:' 得到一个测试用的临时库。 */
export function openDatabase(file: string): Db {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA)
  return db
}
