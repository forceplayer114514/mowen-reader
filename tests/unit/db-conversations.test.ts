import { describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/main/db'
import type { Db } from '../../src/main/db'
import {
  countConversations,
  deleteConversations,
  getConversation,
  insertConversation,
  insertMessage,
  listConversations,
  listMessages,
  updateConversationMerge
} from '../../src/main/db/conversations'
import type { ConversationRecord, MessageRecord } from '../../src/shared/types'

function conv(id: string, over: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    id,
    bookId: '书1',
    startCfi: `epubcfi(/6/4!/4/2/2/1:0)`,
    endCfi: `epubcfi(/6/4!/4/2/8/1:0)`,
    mergedEndCfi: null,
    chapterLabel: '第三章 那个夏天',
    excerpt: '他终于明白过来',
    createdAt: 1000,
    ...over
  }
}

// conversations.book_id 带 REFERENCES books(id) ON DELETE CASCADE,
// 且 openDatabase 已经打开 PRAGMA foreign_keys = ON,所以插入对话前
// 必须先有对应的书籍行,否则会撞上外键约束(这也是级联删除测试的前提)。
function seedBook(db: Db, id: string): void {
  db.prepare(
    `INSERT INTO books (id, title, file_path, source_path, added_at) VALUES (?, ?, ?, ?, ?)`
  ).run(id, `书-${id}`, '/x.epub', '/y.epub', 1)
}

function msg(id: string, convId: string, over: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id,
    conversationId: convId,
    role: 'user',
    content: '这句话什么意思',
    quotes: [],
    createdAt: 2000,
    ...over
  }
}

describe('对话表', () => {
  it('插入后能按 id 取回,字段一致', () => {
    const db = openDatabase(':memory:')
    seedBook(db, '书1')
    insertConversation(db, conv('a'))
    expect(getConversation(db, 'a')).toEqual(conv('a'))
    db.close()
  })

  it('取不存在的对话返回 null', () => {
    const db = openDatabase(':memory:')
    expect(getConversation(db, '没有')).toBeNull()
    db.close()
  })

  it('列表按创建时间升序,并带上消息条数', () => {
    const db = openDatabase(':memory:')
    seedBook(db, '书1')
    insertConversation(db, conv('晚', { createdAt: 20 }))
    insertConversation(db, conv('早', { createdAt: 10 }))
    insertMessage(db, msg('m1', '早'))
    insertMessage(db, msg('m2', '早', { role: 'assistant' }))
    const got = listConversations(db, '书1')
    expect(got.map((c) => c.id)).toEqual(['早', '晚'])
    expect(got[0].messageCount).toBe(2)
    expect(got[1].messageCount).toBe(0)
    db.close()
  })

  it('只列出指定书的对话', () => {
    const db = openDatabase(':memory:')
    seedBook(db, '书1')
    seedBook(db, '书2')
    insertConversation(db, conv('本书'))
    insertConversation(db, conv('别的书', { bookId: '书2' }))
    expect(listConversations(db, '书1').map((c) => c.id)).toEqual(['本书'])
    db.close()
  })

  it('合并终点可以写入也可以清空', () => {
    const db = openDatabase(':memory:')
    seedBook(db, '书1')
    insertConversation(db, conv('a'))
    updateConversationMerge(db, 'a', 'epubcfi(/6/4!/4/2/20/1:0)')
    expect(getConversation(db, 'a')!.mergedEndCfi).toBe('epubcfi(/6/4!/4/2/20/1:0)')
    updateConversationMerge(db, 'a', null)
    expect(getConversation(db, 'a')!.mergedEndCfi).toBeNull()
    db.close()
  })

  it('消息按时间升序返回,引用句子原样往返', () => {
    const db = openDatabase(':memory:')
    seedBook(db, '书1')
    insertConversation(db, conv('a'))
    insertMessage(db, msg('m2', 'a', { createdAt: 20 }))
    insertMessage(db, msg('m1', 'a', {
      createdAt: 10,
      quotes: [{ cfiRange: 'epubcfi(/6/4!/4,/2/1:0,/2/1:5)', text: '他终于明白' }]
    }))
    const got = listMessages(db, 'a')
    expect(got.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(got[0].quotes).toEqual([{ cfiRange: 'epubcfi(/6/4!/4,/2/1:0,/2/1:5)', text: '他终于明白' }])
    expect(got[1].quotes).toEqual([])
    db.close()
  })

  it('批量删除对话会连带删掉它们的消息', () => {
    const db = openDatabase(':memory:')
    seedBook(db, '书1')
    insertConversation(db, conv('a'))
    insertConversation(db, conv('b'))
    insertMessage(db, msg('m1', 'a'))
    insertMessage(db, msg('m2', 'b'))
    deleteConversations(db, ['a'])
    expect(listConversations(db, '书1').map((c) => c.id)).toEqual(['b'])
    expect(listMessages(db, 'a')).toEqual([])
    expect(listMessages(db, 'b').map((m) => m.id)).toEqual(['m2'])
    db.close()
  })

  it('批量删除传空数组不报错也不误删', () => {
    const db = openDatabase(':memory:')
    seedBook(db, '书1')
    insertConversation(db, conv('a'))
    deleteConversations(db, [])
    expect(countConversations(db, '书1')).toBe(1)
    db.close()
  })

  it('统计条数只算指定的书', () => {
    const db = openDatabase(':memory:')
    seedBook(db, '书1')
    seedBook(db, '书2')
    insertConversation(db, conv('a'))
    insertConversation(db, conv('b'))
    insertConversation(db, conv('c', { bookId: '书2' }))
    expect(countConversations(db, '书1')).toBe(2)
    db.close()
  })

  it('删掉书时它的对话和消息一并消失', () => {
    const db = openDatabase(':memory:')
    db.prepare(
      `INSERT INTO books (id, title, file_path, source_path, added_at) VALUES (?, ?, ?, ?, ?)`
    ).run('书1', '测试之书', '/x.epub', '/y.epub', 1)
    insertConversation(db, conv('a'))
    insertMessage(db, msg('m1', 'a'))
    db.prepare('DELETE FROM books WHERE id = ?').run('书1')
    expect(countConversations(db, '书1')).toBe(0)
    expect(listMessages(db, 'a')).toEqual([])
    db.close()
  })
})
