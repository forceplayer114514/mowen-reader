import { randomUUID } from 'node:crypto'
import type { CreateVocabInput, VocabRecord } from '../../shared/vocab-types'
import type { Db } from './index'

const SELECT = `SELECT id, book_id AS bookId, start_cfi AS startCfi, cfi_range AS cfiRange,
  source_text AS sourceText, translation, chapter_label AS chapterLabel,
  created_at AS createdAt, updated_at AS updatedAt
  FROM vocabularies`

export function listVocab(db: Db, bookId: string): VocabRecord[] {
  return db.prepare(`${SELECT} WHERE book_id = ? ORDER BY created_at, id`).all(bookId) as unknown as VocabRecord[]
}

export function createVocab(db: Db, input: CreateVocabInput): VocabRecord {
  const now = Date.now()
  // 同一选区仅一条收藏；重复收藏更新译文与原文快照，保持原 id。
  db.prepare(`INSERT INTO vocabularies
    (id, book_id, start_cfi, cfi_range, source_text, translation, chapter_label, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(book_id, cfi_range) DO UPDATE SET source_text = excluded.source_text,
      translation = excluded.translation, start_cfi = excluded.start_cfi,
      chapter_label = excluded.chapter_label, updated_at = excluded.updated_at`
  ).run(randomUUID(), input.bookId, input.startCfi, input.cfiRange, input.sourceText,
    input.translation, input.chapterLabel, now, now)
  return db.prepare(`${SELECT} WHERE book_id = ? AND cfi_range = ?`).get(input.bookId, input.cfiRange) as unknown as VocabRecord
}

export function deleteVocab(db: Db, id: string): void {
  db.prepare('DELETE FROM vocabularies WHERE id = ?').run(id)
}
