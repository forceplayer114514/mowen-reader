// 本项目故意用 Node 内置的 node:sqlite,不引入原生模块。
// 这要求当前进程的 Node 版本 >= 22.13(见 package.json engines)。
// 在 Electron 主进程里,这个 Node 版本是 Electron 自带的,不是系统 Node:
// electron@33 内置 Node 20,没有 node:sqlite,应用启动即崩溃
// (ERR_UNKNOWN_BUILTIN_MODULE)。所以 Electron 版本本身也是这条约束的一部分——
// 目前锁定 electron ^44.3.0(自带 Node 24)。以后如果降级 Electron,
// 必须同时确认其自带 Node 版本仍 >= 22.13,否则应用会在启动时报同样的错。
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
