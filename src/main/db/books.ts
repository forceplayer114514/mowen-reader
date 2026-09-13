import type { BookRecord } from '../../shared/types'
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
    lastReadAt: row.last_read_at
  }
}

const SELECT = `SELECT id, title, author, cover_path, file_path, source_path, added_at, last_read_cfi, last_read_at FROM books`

export function insertBook(db: Db, book: BookRecord): void {
  db.prepare(
    `INSERT INTO books (id, title, author, cover_path, file_path, source_path, added_at, last_read_cfi, last_read_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    book.id,
    book.title,
    book.author,
    book.coverPath,
    book.filePath,
    book.sourcePath,
    book.addedAt,
    book.lastReadCfi,
    book.lastReadAt
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

export function updateProgress(db: Db, id: string, cfi: string): void {
  db.prepare('UPDATE books SET last_read_cfi = ?, last_read_at = ? WHERE id = ?').run(
    cfi,
    Date.now(),
    id
  )
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
