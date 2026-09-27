import { randomUUID } from 'node:crypto'
import type { AnnotationRecord, CreateAnnotationInput } from '../../shared/types'
import type { Db } from './index'

const SELECT = `SELECT id, book_id AS bookId, start_cfi AS startCfi, cfi_range AS cfiRange,
  quote, chapter_label AS chapterLabel, content, created_at AS createdAt, updated_at AS updatedAt
  FROM annotations`

export function listAnnotations(db: Db, bookId: string): AnnotationRecord[] {
  return db.prepare(`${SELECT} WHERE book_id = ? ORDER BY created_at, id`).all(bookId) as unknown as AnnotationRecord[]
}

export function createAnnotation(db: Db, input: CreateAnnotationInput): AnnotationRecord {
  const now = Date.now()
  // 同一选区仅一条注释；重复提交也保持原 id，编号由原文位置决定。
  db.prepare(`INSERT INTO annotations
    (id, book_id, start_cfi, cfi_range, quote, chapter_label, content, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(book_id, cfi_range) DO UPDATE SET content = excluded.content,
      quote = excluded.quote, start_cfi = excluded.start_cfi,
      chapter_label = excluded.chapter_label, updated_at = excluded.updated_at`
  ).run(randomUUID(), input.bookId, input.startCfi, input.cfiRange, input.quote, input.chapterLabel, input.content, now, now)
  return db.prepare(`${SELECT} WHERE book_id = ? AND cfi_range = ?`).get(input.bookId, input.cfiRange) as unknown as AnnotationRecord
}

export function updateAnnotation(db: Db, id: string, content: string): AnnotationRecord {
  const changed = db.prepare('UPDATE annotations SET content = ?, updated_at = ? WHERE id = ?').run(content, Date.now(), id)
  if (!changed.changes) throw new Error('注释不存在，请重新选择')
  return db.prepare(`${SELECT} WHERE id = ?`).get(id) as unknown as AnnotationRecord
}

export function deleteAnnotation(db: Db, id: string): void {
  db.prepare('DELETE FROM annotations WHERE id = ?').run(id)
}
