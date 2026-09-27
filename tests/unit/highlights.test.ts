import { expect, it } from 'vitest'
import { openDatabase } from '../../src/main/db'
import { insertBook, deleteBook } from '../../src/main/db/books'
import { addHighlight, deleteHighlight, listHighlights } from '../../src/main/db/highlights'

it('高光按原文位置保存，同一范围不重复，删除和书籍级联不影响其他记录', () => {
  const db = openDatabase(':memory:')
  insertBook(db, { id: 'book', title: 'Test', author: null, coverPath: null, sourcePath: '',
    filePath: '', addedAt: 1, lastReadAt: null, lastReadCfi: null })
  const input = { bookId: 'book', startCfi: 'start', cfiRange: 'range', quote: 'Sentence' }
  const first = addHighlight(db, input)
  expect(addHighlight(db, input).id).toBe(first.id)
  expect(listHighlights(db, 'book')).toEqual([first])
  deleteHighlight(db, first.id)
  expect(listHighlights(db, 'book')).toEqual([])
  addHighlight(db, input)
  deleteBook(db, 'book')
  expect(listHighlights(db, 'book')).toEqual([])
  db.close()
})
