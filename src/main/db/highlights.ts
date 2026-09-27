import { randomUUID } from 'node:crypto'
import type { CreateHighlightInput, HighlightRecord } from '../../shared/highlight-types'
import type { Db } from './index'

const SELECT = `SELECT id, book_id AS bookId, cfi_range AS cfiRange,
  start_cfi AS startCfi, quote, created_at AS createdAt
  FROM highlights`

export function listHighlights(db: Db, bookId: string): HighlightRecord[] {
  return db.prepare(`${SELECT} WHERE book_id = ? ORDER BY created_at, id`).all(bookId) as unknown as HighlightRecord[]
}

export function addHighlight(db: Db, input: CreateHighlightInput): HighlightRecord {
  const now = Date.now()
  // 同一范围只存一条:重复提交保持原 id,不复制出第二块高亮。
  db.prepare(`INSERT INTO highlights
    (id, book_id, cfi_range, start_cfi, quote, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(book_id, cfi_range) DO NOTHING`
  ).run(randomUUID(), input.bookId, input.cfiRange, input.startCfi, input.quote, now)
  return db.prepare(`${SELECT} WHERE book_id = ? AND cfi_range = ?`).get(input.bookId, input.cfiRange) as unknown as HighlightRecord
}

export function deleteHighlight(db: Db, id: string): void {
  db.prepare('DELETE FROM highlights WHERE id = ?').run(id)
}
