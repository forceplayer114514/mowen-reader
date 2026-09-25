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

CREATE TABLE IF NOT EXISTS conversations (
  id             TEXT PRIMARY KEY,
  book_id        TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  start_cfi      TEXT NOT NULL,
  end_cfi        TEXT NOT NULL,
  merged_end_cfi TEXT,
  chapter_label  TEXT,
  excerpt        TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversations_book ON conversations(book_id, created_at);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  quotes          TEXT NOT NULL DEFAULT '[]',
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS bookmarks (
  id            TEXT PRIMARY KEY,
  book_id       TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  start_cfi     TEXT NOT NULL,
  chapter_label TEXT,
  excerpt       TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  UNIQUE(book_id, start_cfi)
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_book ON bookmarks(book_id, created_at);
`

export type Db = DatabaseSync

/**
 * 当前 schema 的版本号,存在 SQLite 自带的 `PRAGMA user_version` 里。
 * v0.1.0 发布之后用户机器上会有真实数据库文件,下一阶段要加两张新表时,
 * 迁移代码需要靠这个数字分辨"这是一个从来没升级过的旧库"还是"已经跑过某次
 * 迁移的库",而不是靠猜表结构。schema 目前从未迁移过,这里先只留一个整数
 * 版本和下面 openDatabase() 里写好的插槽,不为此建一整套迁移框架。
 */
export const SCHEMA_VERSION = 3

/** 打开数据库并确保表结构存在。传 ':memory:' 得到一个测试用的临时库。 */
export function openDatabase(file: string): Db {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA)

  const { user_version: version } = db.prepare('PRAGMA user_version').get() as {
    user_version: number
  }
  if (version === 0) {
    // user_version 是全新数据库的默认值(SQLite 本身也拿 0 当"从没设置过"),
    // 这个分支只会在真正第一次创建这个文件时进入一次:盖上当前 schema 版本号。
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  } else if (version < SCHEMA_VERSION) {
    if (version < 2) {
      // v1 的库没有 conversations / messages 两张表。上面的 SCHEMA 用的是
      // CREATE TABLE IF NOT EXISTS,已经把它们建好了,这里只需把版本号推上去。
      db.exec('PRAGMA user_version = 2')
    }
    // bookmarks 表已由上面的幂等 schema 补齐。
    db.exec('PRAGMA user_version = 3')
  }

  return db
}
