import { describe, expect, it } from 'vitest'
import { openDatabase, SCHEMA_VERSION } from '../../src/main/db'
import { insertBook, deleteBook } from '../../src/main/db/books'
import { createVocab, deleteVocab, listVocab } from '../../src/main/db/vocab'

describe('本地生词收藏', () => {
  it('schema 版本为 8 且内存库带 vocabularies 表', () => {
    expect(SCHEMA_VERSION).toBe(8)
    const db = openDatabase(':memory:')
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vocabularies'`).all()
    expect(tables).toHaveLength(1)
    const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
    expect(version).toBe(8)
    db.close()
  })

  it('CRUD、重复选区更新译文并保持 id、按书隔离、删书级联清理', () => {
    const db = openDatabase(':memory:')
    for (const id of ['a', 'b']) insertBook(db, { id, title: id, author: null, coverPath: null,
      filePath: '', sourcePath: '', addedAt: 0, lastReadAt: null, lastReadCfi: null })
    const input = { bookId: 'a', startCfi: 'epubcfi(/6/2!/4/2/1:0)',
      cfiRange: 'epubcfi(/6/2!/4/2,/1:0,/1:12)', sourceText: 'serendipity',
      translation: '〔离线翻译〕\n\n意外之喜', chapterLabel: '第一章' }
    const first = createVocab(db, input)
    expect(listVocab(db, 'a')).toEqual([first])
    const again = createVocab(db, { ...input, translation: '〔在线翻译〕\n\n机缘巧合', sourceText: 'serendipity 更新' })
    expect(again.id).toBe(first.id)
    expect(again).toMatchObject({ sourceText: 'serendipity 更新', translation: '〔在线翻译〕\n\n机缘巧合', createdAt: first.createdAt })
    expect(listVocab(db, 'a')).toHaveLength(1)
    const other = createVocab(db, { ...input, bookId: 'b' })
    deleteVocab(db, first.id)
    expect(listVocab(db, 'a')).toEqual([])
    expect(listVocab(db, 'b')).toEqual([other])
    deleteBook(db, 'b')
    expect(listVocab(db, 'b')).toEqual([])
    db.close()
  })
})
