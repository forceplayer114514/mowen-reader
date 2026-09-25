import { describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/main/db'
import {
  deleteBook,
  deleteBookmark,
  getBook,
  getLocations,
  insertBookmark,
  insertBook,
  listBookmarks,
  listBooks,
  listSourcePaths,
  setLocations,
  updateProgress
} from '../../src/main/db/books'
import type { BookRecord } from '../../src/shared/types'

function make(id: string, over: Partial<BookRecord> = {}): BookRecord {
  return {
    id,
    title: `书 ${id}`,
    author: '某人',
    coverPath: null,
    filePath: `/data/books/${id}.epub`,
    sourcePath: `/Users/me/Downloads/${id}.epub`,
    addedAt: 1000,
    lastReadCfi: null,
    lastReadAt: null,
    ...over
  }
}

describe('books 表', () => {
  it('插入后能按 id 取回,字段一致', () => {
    const db = openDatabase(':memory:')
    insertBook(db, make('a', { author: null, coverPath: '/c/a.png' }))
    const got = getBook(db, 'a')
    expect(got).toEqual(make('a', { author: null, coverPath: '/c/a.png' }))
    db.close()
  })

  it('取不存在的 id 返回 null 而不是抛异常', () => {
    const db = openDatabase(':memory:')
    expect(getBook(db, '不存在')).toBeNull()
    db.close()
  })

  it('列表把读过的排在前面,同类按时间倒序', () => {
    const db = openDatabase(':memory:')
    insertBook(db, make('老书', { addedAt: 1 }))
    insertBook(db, make('新书', { addedAt: 2 }))
    insertBook(db, make('读过的', { addedAt: 0, lastReadAt: 500 }))
    expect(listBooks(db).map((b) => b.id)).toEqual(['读过的', '新书', '老书'])
    db.close()
  })

  it('更新进度会同时写入位置和时间', () => {
    const db = openDatabase(':memory:')
    insertBook(db, make('a'))
    updateProgress(db, 'a', 'epubcfi(/6/4!/4/2/2)')
    const got = getBook(db, 'a')!
    expect(got.lastReadCfi).toBe('epubcfi(/6/4!/4/2/2)')
    expect(got.lastReadAt).toBeGreaterThan(0)
    db.close()
  })

  it('删除后列表里没有了', () => {
    const db = openDatabase(':memory:')
    insertBook(db, make('a'))
    deleteBook(db, 'a')
    expect(listBooks(db)).toEqual([])
    db.close()
  })

  it('分页位置索引可存可取,没存过是 null', () => {
    const db = openDatabase(':memory:')
    insertBook(db, make('a'))
    expect(getLocations(db, 'a')).toBeNull()
    setLocations(db, 'a', '["cfi1","cfi2"]')
    expect(getLocations(db, 'a')).toBe('["cfi1","cfi2"]')
    db.close()
  })

  it('读过的书按上次打开时间倒序,未读书在后', () => {
    const db = openDatabase(':memory:')
    // Insert unread books
    insertBook(db, make('unread1', { addedAt: 100 }))
    insertBook(db, make('unread2', { addedAt: 200 }))
    // Insert read books with different last_read_at times
    insertBook(db, make('read1', { addedAt: 50, lastReadAt: 1000 }))
    insertBook(db, make('read2', { addedAt: 60, lastReadAt: 2000 }))
    expect(listBooks(db).map((b) => b.id)).toEqual(['read2', 'read1', 'unread2', 'unread1'])
    db.close()
  })

  it('能按源路径列出已导入的书,用于扫描判重', () => {
    const db = openDatabase(':memory:')
    insertBook(db, make('a'))
    insertBook(db, make('b'))
    expect(listSourcePaths(db).sort()).toEqual([
      '/Users/me/Downloads/a.epub',
      '/Users/me/Downloads/b.epub'
    ])
    db.close()
  })

  it('书签可存取删除,删书时一并清理', () => {
    const db = openDatabase(':memory:')
    insertBook(db, make('a'))
    insertBookmark(db, {
      id: 'mark-1',
      bookId: 'a',
      startCfi: 'epubcfi(/6/4!/4/2/2)',
      chapterLabel: '第一章',
      excerpt: '这一页的开头',
      createdAt: 1000
    })
    expect(listBookmarks(db, 'a')).toHaveLength(1)
    deleteBookmark(db, 'mark-1')
    expect(listBookmarks(db, 'a')).toEqual([])

    insertBookmark(db, {
      id: 'mark-2',
      bookId: 'a',
      startCfi: 'epubcfi(/6/4!/4/2/4)',
      chapterLabel: null,
      excerpt: '',
      createdAt: 2000
    })
    deleteBook(db, 'a')
    expect(listBookmarks(db, 'a')).toEqual([])
    db.close()
  })
})
