import type { Db } from './index'
import type { ReadingStats } from '../../shared/reading-stats'

export function saveReadingTime(db: Db, bookId: string, entries: Map<string, number>): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    const insert = db.prepare(`INSERT INTO reading_time (book_id, day, milliseconds)
      SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM books WHERE id = ?)
      ON CONFLICT(book_id, day) DO UPDATE SET milliseconds = milliseconds + excluded.milliseconds`)
    for (const [day, milliseconds] of entries) {
      if (milliseconds > 0) insert.run(bookId, day, milliseconds, bookId)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function getReadingStats(db: Db): ReadingStats {
  return {
    days: db.prepare(`SELECT day, SUM(milliseconds) AS milliseconds FROM reading_time
      GROUP BY day ORDER BY day`).all() as unknown as ReadingStats['days'],
    books: db.prepare(`SELECT book_id AS bookId, SUM(milliseconds) AS milliseconds,
      COUNT(*) AS days, MAX(day) AS lastDay FROM reading_time
      GROUP BY book_id ORDER BY milliseconds DESC, book_id`).all() as unknown as ReadingStats['books']
  }
}
