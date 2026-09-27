import type { BookmarkRecord, BookRecord } from '../../shared/types'
import type { Db } from './index'

interface Row {
  id: string
  title: string
  author: string | null
  cover_path: string | null
  file_path: string
  source_path: string
  added_at: number
  last_read_cfi: string | null
  last_read_at: number | null
  read_progress: number
}

function toRecord(row: Row): BookRecord {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    coverPath: row.cover_path,
    filePath: row.file_path,
    sourcePath: row.source_path,
    addedAt: row.added_at,
    lastReadCfi: row.last_read_cfi,
    lastReadAt: row.last_read_at,
    readProgress: Math.max(0, Math.min(1, row.read_progress ?? 0))
  }
}

const SELECT = `SELECT id, title, author, cover_path, file_path, source_path, added_at, last_read_cfi, last_read_at, read_progress FROM books`

export function insertBook(db: Db, book: BookRecord): void {
  db.prepare(
    `INSERT INTO books (id, title, author, cover_path, file_path, source_path, added_at, last_read_cfi, last_read_at, read_progress)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    book.id,
    book.title,
    book.author,
    book.coverPath,
    book.filePath,
    book.sourcePath,
    book.addedAt,
    book.lastReadCfi,
    book.lastReadAt,
    book.readProgress ?? 0
  )
}

export function getBook(db: Db, id: string): BookRecord | null {
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id) as Row | undefined
  return row ? toRecord(row) : null
}

/** 读过的排前面(按上次打开时间倒序),没读过的排后面(按导入时间倒序)。 */
export function listBooks(db: Db): BookRecord[] {
  const rows = db
    .prepare(
      `${SELECT}
       ORDER BY (last_read_at IS NULL) ASC,
                last_read_at DESC,
                added_at DESC`
    )
    .all() as unknown as Row[]
  return rows.map(toRecord)
}

export function deleteBook(db: Db, id: string): void {
  db.prepare('DELETE FROM books WHERE id = ?').run(id)
}

export function updateProgress(db: Db, id: string, cfi: string, progress = 0): void {
  if (typeof id !== 'string' || typeof cfi !== 'string' || !cfi || !Number.isFinite(progress) || progress < 0 || progress > 1) {
    throw new Error('阅读位置或进度无效')
  }
  // 已读进度保留最远位置；回翻和重排不撤销已读完状态，恢复位置仍跟随当前页。
  db.prepare('UPDATE books SET last_read_cfi = ?, last_read_at = ?, read_progress = MAX(read_progress, ?) WHERE id = ?').run(
    cfi,
    Date.now(),
    progress,
    id
  )
}

/** 正文已显示即记为最近阅读，不覆盖恢复中的 CFI，也不要求用户必须翻页。 */
export function markBookRead(db: Db, id: string): void {
  db.prepare('UPDATE books SET last_read_at = ? WHERE id = ?').run(Date.now(), id)
}

export function getLocations(db: Db, id: string): string | null {
  const row = db.prepare('SELECT locations FROM books WHERE id = ?').get(id) as
    | { locations: string | null }
    | undefined
  return row?.locations ?? null
}

export function setLocations(db: Db, id: string, json: string): void {
  db.prepare('UPDATE books SET locations = ? WHERE id = ?').run(json, id)
}

export function listSourcePaths(db: Db): string[] {
  const rows = db.prepare('SELECT source_path FROM books').all() as { source_path: string }[]
  return rows.map((r) => r.source_path).filter((p) => p.length > 0)
}

interface BookmarkRow {
  id: string
  book_id: string
  start_cfi: string
  chapter_label: string | null
  excerpt: string
  created_at: number
}

function toBookmark(row: BookmarkRow): BookmarkRecord {
  return {
    id: row.id,
    bookId: row.book_id,
    startCfi: row.start_cfi,
    chapterLabel: row.chapter_label,
    excerpt: row.excerpt,
    createdAt: row.created_at
  }
}

export function listBookmarks(db: Db, bookId: string): BookmarkRecord[] {
  const rows = db.prepare(
    `SELECT id, book_id, start_cfi, chapter_label, excerpt, created_at
       FROM bookmarks WHERE book_id = ? ORDER BY created_at ASC`
  ).all(bookId) as unknown as BookmarkRow[]
  return rows.map(toBookmark)
}

export function insertBookmark(db: Db, bookmark: BookmarkRecord): void {
  db.prepare(
    `INSERT INTO bookmarks (id, book_id, start_cfi, chapter_label, excerpt, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    bookmark.id,
    bookmark.bookId,
    bookmark.startCfi,
    bookmark.chapterLabel,
    bookmark.excerpt,
    bookmark.createdAt
  )
}

export function deleteBookmark(db: Db, id: string): void {
  db.prepare('DELETE FROM bookmarks WHERE id = ?').run(id)
}
