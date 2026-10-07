import { createHash, randomUUID } from 'node:crypto'
import type { BookSegmentRecord } from '../../shared/book-translation'
import { normalizeBookText } from '../../shared/book-translation'
import type { Db } from './index'

interface Row {
  book_id: string
  seg_hash: string
  source_text: string
  translated_text: string
  engine: string
  updated_at: number
}

/** 分句缓存键：书内按归一化原文寻址。同样文字在任何页面/字号下键都相同。 */
export function segHashOf(bookId: string, sourceText: string): string {
  return createHash('sha256').update(`${bookId}\n${normalizeBookText(sourceText)}`).digest('hex')
}

function assertBookId(bookId: string): void {
  if (typeof bookId !== 'string' || !bookId || bookId.length > 200) throw new Error('书籍 id 无效')
}

function assertHashes(hashes: string[]): void {
  if (!Array.isArray(hashes) || hashes.some((h) => typeof h !== 'string' || !/^[a-f0-9]{64}$/.test(h))) {
    throw new Error('分句键无效')
  }
}

function toRecord(row: Row): BookSegmentRecord {
  return {
    bookId: row.book_id,
    segHash: row.seg_hash,
    sourceText: row.source_text,
    translatedText: row.translated_text,
    engine: row.engine,
    updatedAt: row.updated_at
  }
}

/** 按键批量取缓存（记号检查）：命中即已翻译，无需调模型。 */
export function getBookSegments(db: Db, bookId: string, hashes: string[]): Map<string, BookSegmentRecord> {
  assertBookId(bookId)
  assertHashes(hashes)
  const out = new Map<string, BookSegmentRecord>()
  if (hashes.length === 0) return out
  const unique = [...new Set(hashes)]
  const placeholders = unique.map(() => '?').join(',')
  const rows = db.prepare(
    `SELECT book_id, seg_hash, source_text, translated_text, engine, updated_at
       FROM book_segments WHERE book_id = ? AND seg_hash IN (${placeholders})`
  ).all(bookId, ...unique) as unknown as Row[]
  for (const row of rows) out.set(row.seg_hash, toRecord(row))
  return out
}

/** 整书已缓存分句数（供阅读页状态展示）。 */
export function countBookSegments(db: Db, bookId: string): number {
  assertBookId(bookId)
  const row = db.prepare('SELECT COUNT(*) AS n FROM book_segments WHERE book_id = ?').get(bookId) as
    | { n: number }
    | undefined
  return row?.n ?? 0
}

export interface SaveSegmentInput {
  bookId: string
  sourceText: string
  translatedText: string
  engine?: string
}

/**
 * 批量写入分句缓存（upsert）。缓存永久保留：关闭/禁用/重开均不删除；
 * 删书时由外键级联清理。
 */
export function saveBookSegments(db: Db, inputs: SaveSegmentInput[]): void {
  if (!Array.isArray(inputs) || inputs.length === 0) return
  const now = Date.now()
  const stmt = db.prepare(
    `INSERT INTO book_segments (id, book_id, seg_hash, source_text, translated_text, engine, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(book_id, seg_hash) DO UPDATE SET translated_text=excluded.translated_text, engine=excluded.engine, updated_at=excluded.updated_at`
  )
  for (const input of inputs) {
    if (!input || typeof input.sourceText !== 'string' || !normalizeBookText(input.sourceText)) {
      throw new Error('可翻译的原文无效')
    }
    if (typeof input.translatedText !== 'string' || !input.translatedText.trim() || input.translatedText.length > 20000) {
      throw new Error('译文无效')
    }
    assertBookId(input.bookId)
    const source = normalizeBookText(input.sourceText)
    stmt.run(
      randomUUID(),
      input.bookId,
      segHashOf(input.bookId, source),
      source,
      input.translatedText.trim(),
      input.engine ?? 'ai',
      now
    )
  }
}
