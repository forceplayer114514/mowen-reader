import { describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/main/db'
import { getTranslationEnabled, insertBook, setTranslationEnabled } from '../../src/main/db/books'
import {
  countBookTranslations,
  getBookTranslation,
  saveBookTranslation
} from '../../src/main/db/book-translations'
import {
  bookTranslationKey,
  MAX_BOOK_PAGE_CHARS,
  nextBookTranslationKey
} from '../../src/shared/book-translation'

function book(id: string) {
  return {
    id,
    title: id,
    author: null,
    coverPath: null,
    filePath: `/b/${id}.epub`,
    sourcePath: `/s/${id}.epub`,
    addedAt: 1,
    lastReadCfi: null,
    lastReadAt: null,
    readProgress: 0,
    translationEnabled: false as const
  }
}

describe('整书 AI 翻译开关', () => {
  it('默认关闭，且按书独立', () => {
    const db = openDatabase(':memory:')
    insertBook(db, book('a'))
    insertBook(db, book('b'))
    expect(getTranslationEnabled(db, 'a')).toBe(false)
    setTranslationEnabled(db, 'a', true)
    expect(getTranslationEnabled(db, 'a')).toBe(true)
    expect(getTranslationEnabled(db, 'b')).toBe(false)
    setTranslationEnabled(db, 'a', false)
    expect(getTranslationEnabled(db, 'a')).toBe(false)
    db.close()
  })

  it('旧库升级后默认关闭（列缺失时迁移补齐）', () => {
    const db = openDatabase(':memory:')
    db.exec('ALTER TABLE books DROP COLUMN translation_enabled')
    // 模拟旧库：删掉列后仍能写入（新代码用 0 填充），再补列。
    db.exec('ALTER TABLE books ADD COLUMN translation_enabled INTEGER NOT NULL DEFAULT 0')
    insertBook(db, book('old'))
    expect(getTranslationEnabled(db, 'old')).toBe(false)
    db.close()
  })
})

describe('逐页翻译缓存', () => {
  it('写入后可按页键取回，关闭/禁用不删除', () => {
    const db = openDatabase(':memory:')
    insertBook(db, book('a'))
    expect(getBookTranslation(db, 'a', 'pdf-page-1')).toBeNull()
    const saved = saveBookTranslation(db, {
      bookId: 'a',
      pageKey: 'pdf-page-1',
      sourceText: 'Hello world',
      translatedText: '你好世界'
    })
    expect(saved.translatedText).toBe('你好世界')
    expect(getBookTranslation(db, 'a', 'pdf-page-1')?.translatedText).toBe('你好世界')
    expect(countBookTranslations(db, 'a')).toBe(1)
    // 禁用开关不删除缓存。
    setTranslationEnabled(db, 'a', false)
    expect(getBookTranslation(db, 'a', 'pdf-page-1')?.translatedText).toBe('你好世界')
    expect(countBookTranslations(db, 'a')).toBe(1)
    db.close()
  })

  it('同一键正文变化时更新译文（排版微调不展示错位）', () => {
    const db = openDatabase(':memory:')
    insertBook(db, book('a'))
    saveBookTranslation(db, { bookId: 'a', pageKey: 'pdf-page-1', sourceText: 'Hello', translatedText: '你好' })
    saveBookTranslation(db, { bookId: 'a', pageKey: 'pdf-page-1', sourceText: 'Hello world!', translatedText: '你好，世界！' })
    const got = getBookTranslation(db, 'a', 'pdf-page-1')!
    expect(got.sourceText).toBe('Hello world!')
    expect(got.translatedText).toBe('你好，世界！')
    expect(countBookTranslations(db, 'a')).toBe(1)
    db.close()
  })

  it('删书时缓存级联清理', () => {
    const db = openDatabase(':memory:')
    insertBook(db, book('a'))
    saveBookTranslation(db, { bookId: 'a', pageKey: 'pdf-page-1', sourceText: 'Hi', translatedText: '嗨' })
    db.prepare('DELETE FROM books WHERE id = ?').run('a')
    expect(countBookTranslations(db, 'a')).toBe(0)
    db.close()
  })
})

describe('翻译页键', () => {
  it('PDF 按物理页码，EPUB 按起点 CFI', () => {
    expect(bookTranslationKey({ page: 3 }, true)).toBe('pdf-page-3')
    expect(bookTranslationKey({ page: 1, startCfi: 'epubcfi(/6/4!/4/2)' }, false)).toBe(
      'epub-epubcfi(/6/4!/4/2)'
    )
  })

  it('PDF 下一页在末页返回 null，EPUB 需翻页后才知道', () => {
    expect(nextBookTranslationKey({ page: 1, totalPages: 5 }, true)).toBe('pdf-page-2')
    expect(nextBookTranslationKey({ page: 5, totalPages: 5 }, true)).toBeNull()
    expect(nextBookTranslationKey({ page: 2, totalPages: 10 }, false)).toBeNull()
  })

  it('单页上限与划词翻译一致（10000 字）', () => {
    expect(MAX_BOOK_PAGE_CHARS).toBe(10000)
  })
})
