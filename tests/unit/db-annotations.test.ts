import { describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/main/db'
import { insertBook, deleteBook } from '../../src/main/db/books'
import { createAnnotation, deleteAnnotation, listAnnotations, updateAnnotation } from '../../src/main/db/annotations'

describe('本地注释', () => {
  it('CRUD、重复选区保持 id、按书隔离、删书级联清理', () => {
    const db = openDatabase(':memory:')
    for (const id of ['a', 'b']) insertBook(db, { id, title: id, author: null, coverPath: null,
      filePath: '', sourcePath: '', addedAt: 0, lastReadAt: null, lastReadCfi: null })
    const input = { bookId: 'a', startCfi: 'epubcfi(/6/2!/4/2/1:0)',
      cfiRange: 'epubcfi(/6/2!/4/2,/1:0,/1:12)', quote: '原文', chapterLabel: '第一章', content: '想法' }
    const first = createAnnotation(db, input)
    expect(listAnnotations(db, 'a')).toEqual([first])
    const again = createAnnotation(db, { ...input, content: '修改', quote: '更新原文', chapterLabel: '新章名' })
    expect(again.id).toBe(first.id)
    expect(again).toMatchObject({ quote: '更新原文', chapterLabel: '新章名', createdAt: first.createdAt })
    expect(listAnnotations(db, 'a')).toHaveLength(1)
    expect(updateAnnotation(db, first.id, '更新').content).toBe('更新')
    const other = createAnnotation(db, { ...input, bookId: 'b' })
    deleteAnnotation(db, first.id)
    expect(listAnnotations(db, 'a')).toEqual([])
    expect(listAnnotations(db, 'b')).toEqual([other])
    expect(() => updateAnnotation(db, first.id, '失效')).toThrow('不存在')
    deleteBook(db, 'b')
    expect(listAnnotations(db, 'b')).toEqual([])
    db.close()
  })
})
