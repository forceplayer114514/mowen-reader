import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase, SCHEMA_VERSION } from '../../src/main/db'
import { insertBook, updateProgress, getBook } from '../../src/main/db/books'
import { insertConversation, insertMessage, listMessages } from '../../src/main/db/conversations'
import { createAnnotation, listAnnotations } from '../../src/main/db/annotations'

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
    dir = mkdtempSync(join(tmpdir(), 'reader-mig-'))
    const file = join(dir, 'old.db')
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
    expect(() => db.prepare('SELECT COUNT(*) FROM bookmarks').get()).not.toThrow()
    expect(() => db.prepare('SELECT COUNT(*) FROM annotations').get()).not.toThrow()
    db.close()
  })

  it('v3 升级和反复重开保留阅读位置、对话、消息、书签及提交后的注释', () => {
    dir = mkdtempSync(join(tmpdir(), 'reader-mig-data-'))
    const file = join(dir, 'reader.db')
    let db = openDatabase(file)
    const cfi = 'epubcfi(/6/4!/4/2/1:20)'
    insertBook(db, { id: 'b', title: '旧书', author: null, coverPath: null, filePath: '/b.epub',
      sourcePath: '', addedAt: 1, lastReadAt: null, lastReadCfi: null })
    updateProgress(db, 'b', cfi)
    insertConversation(db, { id: 'c', bookId: 'b', startCfi: cfi, endCfi: cfi,
      mergedEndCfi: null, chapterLabel: '第二章', excerpt: '原文', createdAt: 1 })
    insertMessage(db, { id: 'm', conversationId: 'c', role: 'user', content: '旧对话', quotes: [], createdAt: 1 })
    db.prepare('INSERT INTO bookmarks (id,book_id,start_cfi,created_at) VALUES (?,?,?,?)').run('mark', 'b', cfi, 1)
    db.prepare('INSERT INTO settings VALUES (?,?)').run('theme', 'dark')
    db.exec('DROP TABLE annotations; PRAGMA user_version = 3')
    db.close()
    db = openDatabase(file)
    const note = createAnnotation(db, { bookId: 'b', startCfi: cfi,
      cfiRange: 'epubcfi(/6/4!/4/2,/1:20,/1:30)', quote: '原文', chapterLabel: '第二章', content: '提交的注释' })
    db.close()
    for (let i = 0; i < 3; i++) {
      db = openDatabase(file)
      expect(getBook(db, 'b')?.lastReadCfi).toBe(cfi)
      expect(listMessages(db, 'c')).toMatchObject([{ id: 'm', content: '旧对话' }])
      expect(listAnnotations(db, 'b')).toEqual([note])
      expect(db.prepare('SELECT id FROM bookmarks').get()).toMatchObject({ id: 'mark' })
      expect(db.prepare('SELECT value FROM settings WHERE key = ?').get('theme')).toMatchObject({ value: 'dark' })
      expect(db.prepare('PRAGMA integrity_check').get()).toMatchObject({ integrity_check: 'ok' })
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      db.close()
    }
  })

  it('拒绝未来版本，不覆盖原表；迁移失败回滚新增表和版本号', () => {
    dir = mkdtempSync(join(tmpdir(), 'reader-mig-safe-'))
    const future = join(dir, 'future.db')
    let raw = new DatabaseSync(future)
    raw.exec(`CREATE TABLE keep (value TEXT); INSERT INTO keep VALUES ('保留'); PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
    raw.close()
    expect(() => openDatabase(future)).toThrow('更新版本')
    raw = new DatabaseSync(future)
    expect(raw.prepare('SELECT * FROM keep').get()).toMatchObject({ value: '保留' })
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toMatchObject([{ name: 'keep' }])
    raw.close()
    const broken = join(dir, 'broken.db')
    raw = new DatabaseSync(broken)
    raw.exec('CREATE TABLE conversations (id TEXT); PRAGMA user_version = 1')
    raw.close()
    expect(() => openDatabase(broken)).toThrow()
    raw = new DatabaseSync(broken)
    expect(raw.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 1 })
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toMatchObject([{ name: 'conversations' }])
    raw.close()
  })
})
