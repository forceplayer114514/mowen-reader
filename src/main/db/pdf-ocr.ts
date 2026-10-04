import { randomUUID } from 'node:crypto'
import type { PdfOcrResult, PdfPosition } from '../../shared/pdf-ocr-types'
import type { Db } from './index'

const SELECT = `SELECT id, book_id AS bookId, page, language, region, text, words, created_at AS createdAt FROM pdf_ocr`
function decode(row: unknown): PdfOcrResult {
  const result = row as Omit<PdfOcrResult, 'region' | 'words'> & { region: string | null; words: string }
  return { ...result, region: result.region ? JSON.parse(result.region) : null, words: JSON.parse(result.words) }
}
export function getPdfOcr(db: Db, bookId: string, page: number): PdfOcrResult[] {
  return db.prepare(`${SELECT} WHERE book_id = ? AND page = ? ORDER BY created_at, rowid`).all(bookId, page).map(decode)
}
export function cachedPdfOcr(db: Db, bookId: string, page: number, key: string): PdfOcrResult | null {
  const row = db.prepare(`${SELECT} WHERE book_id = ? AND page = ? AND cache_key = ?`).get(bookId, page, key)
  return row ? decode(row) : null
}
export function savePdfOcr(db: Db, key: string, result: Omit<PdfOcrResult, 'id' | 'createdAt'>): PdfOcrResult {
  // Never replace a recognized layer: persistent text indices also anchor notes/highlights.
  db.prepare(`INSERT INTO pdf_ocr (id, book_id, page, cache_key, language, region, text, words, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(book_id, page, cache_key) DO NOTHING`).run(
    randomUUID(), result.bookId, result.page, key, result.language,
    result.region ? JSON.stringify(result.region) : null, result.text, JSON.stringify(result.words), Date.now())
  return cachedPdfOcr(db, result.bookId, result.page, key)!
}
export function getPdfPosition(db: Db, bookId: string): PdfPosition | null {
  return db.prepare('SELECT page, x, y FROM pdf_positions WHERE book_id = ?').get(bookId) as unknown as PdfPosition | undefined ?? null
}
export function savePdfPosition(db: Db, bookId: string, position: PdfPosition): void {
  db.prepare(`INSERT INTO pdf_positions (book_id, page, x, y) VALUES (?, ?, ?, ?)
    ON CONFLICT(book_id) DO UPDATE SET page=excluded.page, x=excluded.x, y=excluded.y`).run(bookId, position.page, position.x, position.y)
}
