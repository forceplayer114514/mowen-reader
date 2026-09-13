import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase, SCHEMA_VERSION } from '../../src/main/db'

describe('数据库版本标记', () => {
  let dir: string | null = null

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
      dir = null
    }
  })

  it('全新数据库打开后 user_version 就是当前 schema 版本号', () => {
    const db = openDatabase(':memory:')
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
    expect(row.user_version).toBe(SCHEMA_VERSION)
    db.close()
  })

  it('重新打开已有数据库文件,不会改动或重置已经盖上的版本号', () => {
    dir = mkdtempSync(join(tmpdir(), 'reader-db-version-'))
    const file = join(dir, 'library.db')

    const first = openDatabase(file)
    const firstVersion = (first.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version
    expect(firstVersion).toBe(SCHEMA_VERSION)
    first.close()

    const second = openDatabase(file)
    const secondVersion = (
      second.prepare('PRAGMA user_version').get() as { user_version: number }
    ).user_version
    expect(secondVersion).toBe(SCHEMA_VERSION)
    second.close()
  })

  it('v1 的旧库打开后会补齐新表并把版本号推到当前值', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'reader-mig-')), 'old.db')
    // 造一个只有 v1 结构的库
    const old = new DatabaseSync(file)
    old.exec(`CREATE TABLE books (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT, cover_path TEXT,
      file_path TEXT NOT NULL, source_path TEXT NOT NULL DEFAULT '', locations TEXT,
      added_at INTEGER NOT NULL, last_read_cfi TEXT, last_read_at INTEGER)`)
    old.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
    old.prepare(
      `INSERT INTO books (id, title, file_path, source_path, added_at) VALUES (?, ?, ?, ?, ?)`
    ).run('保留的书', '旧书', '/a.epub', '/b.epub', 1)
    old.exec('PRAGMA user_version = 1')
    old.close()

    const db = openDatabase(file)
    const { user_version: version } = db.prepare('PRAGMA user_version').get() as {
      user_version: number
    }
    expect(version).toBe(SCHEMA_VERSION)
    // 原有数据没被破坏
    const row = db.prepare('SELECT title FROM books WHERE id = ?').get('保留的书') as {
      title: string
    }
    expect(row.title).toBe('旧书')
    // 新表可用
    expect(() => db.prepare('SELECT COUNT(*) FROM conversations').get()).not.toThrow()
    db.close()
  })
})
