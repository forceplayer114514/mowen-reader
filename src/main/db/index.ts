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
  last_read_at  INTEGER,
  read_progress REAL NOT NULL DEFAULT 0,
  translation_enabled INTEGER NOT NULL DEFAULT 0
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

CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  start_cfi TEXT NOT NULL,
  cfi_range TEXT NOT NULL,
  quote TEXT NOT NULL,
  chapter_label TEXT,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(book_id, cfi_range)
);
CREATE INDEX IF NOT EXISTS idx_annotations_book ON annotations(book_id);

CREATE TABLE IF NOT EXISTS highlights (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  cfi_range TEXT NOT NULL,
  start_cfi TEXT NOT NULL,
  quote TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE(book_id, cfi_range)
);

CREATE INDEX IF NOT EXISTS idx_highlights_book ON highlights(book_id, created_at);

CREATE TABLE IF NOT EXISTS reading_time (
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  milliseconds INTEGER NOT NULL CHECK(typeof(milliseconds) = 'integer' AND milliseconds > 0),
  PRIMARY KEY(book_id, day)
);

CREATE TABLE IF NOT EXISTS vocabularies (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  start_cfi TEXT NOT NULL,
  cfi_range TEXT NOT NULL,
  source_text TEXT NOT NULL,
  translation TEXT NOT NULL,
  chapter_label TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(book_id, cfi_range)
);

CREATE INDEX IF NOT EXISTS idx_vocabularies_book ON vocabularies(book_id);

CREATE TABLE IF NOT EXISTS pdf_ocr (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  cache_key TEXT NOT NULL,
  language TEXT NOT NULL,
  region TEXT,
  text TEXT NOT NULL,
  words TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(book_id, page, cache_key)
);
CREATE INDEX IF NOT EXISTS idx_pdf_ocr_page ON pdf_ocr(book_id, page);
CREATE TABLE IF NOT EXISTS pdf_positions (
  book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS book_segments (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  seg_hash TEXT NOT NULL,
  source_text TEXT NOT NULL,
  translated_text TEXT NOT NULL,
  engine TEXT NOT NULL DEFAULT 'ai',
  updated_at INTEGER NOT NULL,
  UNIQUE(book_id, seg_hash)
);
CREATE INDEX IF NOT EXISTS idx_book_segments_book ON book_segments(book_id, updated_at);
`

export type Db = DatabaseSync

/** SQLite user_version：v2 对话、v3 书签、v4 注释、v5 高亮、v6 阅读时长、v7 阅读进度、v8 生词收藏、v9 PDF OCR/视口、v10 整书 AI 翻译开关、v11 内容分句缓存（退役按页缓存）。 */
export const SCHEMA_VERSION = 11

/** 打开数据库并确保表结构存在。传 ':memory:' 得到一个测试用的临时库。 */
export function openDatabase(file: string): Db {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = FULL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA foreign_keys = ON')
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as {
    user_version: number
  }
  if (version > SCHEMA_VERSION) {
    db.close()
    throw new Error('数据库来自更新版本的墨问，请使用新版打开；原有数据未修改')
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    const oldBookColumns = db.prepare('PRAGMA table_info(books)').all() as { name: string }[]
    const hadProgress = oldBookColumns.some(column => column.name === 'read_progress')
    const hadTranslationEnabled = oldBookColumns.some(column => column.name === 'translation_enabled')
    db.exec(SCHEMA)
    if (version < 7 && oldBookColumns.length > 0 && !hadProgress) db.exec('ALTER TABLE books ADD COLUMN read_progress REAL NOT NULL DEFAULT 0')
    if (oldBookColumns.length > 0 && !hadTranslationEnabled) db.exec('ALTER TABLE books ADD COLUMN translation_enabled INTEGER NOT NULL DEFAULT 0')
    // v11：缓存单位从“页”改为“内容分句”，旧按页缓存无法复用，直接退役
    // （升级后各页首次查看时重新翻译一次，之后永久复用）。
    db.exec('DROP TABLE IF EXISTS book_translations')
    // 幂等 schema 补齐新增表，所有迁移成功后才升级版本号。
    if (version < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    db.close()
    throw error
  }
  return db
}
