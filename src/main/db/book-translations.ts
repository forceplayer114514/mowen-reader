import { randomUUID } from 'node:crypto'
import type { BookTranslationRecord } from '../../shared/book-translation'
import type { Db } from './index'

interface Row {
  book_id: string
  page_key: string
  source_text: string
  translated_text: string
  engine: string
  updated_at: number
}

function toRecord(row: Row): BookTranslationRecord {
  return {
    bookId: row.book_id,
    pageKey: row.page_key,
    sourceText: row.source_text,
    translatedText: row.translated_text,
    engine: row.engine,
    updatedAt: row.updated_at
  }
}

function assertKey(bookId: string, pageKey: string): void {
  if (typeof bookId !== 'string' || !bookId || bookId.length > 200) throw new Error('书籍 id 无效')
  if (typeof pageKey !== 'string' || !pageKey || pageKey.length > 4096) throw new Error('翻译页键无效')
}

/** 取单页缓存；没有返回 null。缓存永久保留，关闭/禁用均不删除。 */
export function getBookTranslation(db: Db, bookId: string, pageKey: string): BookTranslationRecord | null {
  assertKey(bookId, pageKey)
  const row = db.prepare(
    'SELECT book_id, page_key, source_text, translated_text, engine, updated_at FROM book_translations WHERE book_id = ? AND page_key = ?'
  ).get(bookId, pageKey) as unknown as Row | undefined
  return row ? toRecord(row) : null
}

/** 整书已缓存页数（供阅读页状态展示）。 */
export function countBookTranslations(db: Db, bookId: string): number {
  if (typeof bookId !== 'string' || !bookId) throw new Error('书籍 id 无效')
  const row = db.prepare('SELECT COUNT(*) AS n FROM book_translations WHERE book_id = ?').get(bookId) as
    | { n: number }
    | undefined
  return row?.n ?? 0
}

/**
 * 写入单页缓存（upsert）。
 * 同一键命中但正文变化（排版微调）时更新为最新译文；旧键保留，不做任何删除。
 */
export function saveBookTranslation(
  db: Db,
  input: { bookId: string; pageKey: string; sourceText: string; translatedText: string; engine?: string }
): BookTranslationRecord {
  assertKey(input.bookId, input.pageKey)
  if (typeof input.sourceText !== 'string' || !input.sourceText.trim() || input.sourceText.length > 20000) {
    throw new Error('可翻译的原文无效')
  }
  if (typeof input.translatedText !== 'string' || !input.translatedText.trim() || input.translatedText.length > 40000) {
    throw new Error('译文无效')
  }
  const engine = input.engine ?? 'ai'
  const now = Date.now()
  db.prepare(
    `INSERT INTO book_translations (id, book_id, page_key, source_text, translated_text, engine, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(book_id, page_key) DO UPDATE SET source_text=excluded.source_text, translated_text=excluded.translated_text, engine=excluded.engine, updated_at=excluded.updated_at`
  ).run(randomUUID(), input.bookId, input.pageKey, input.sourceText, input.translatedText, engine, now)
  return getBookTranslation(db, input.bookId, input.pageKey)!
}
