import { describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/main/db'
import { getTranslationEnabled, insertBook, setTranslationEnabled } from '../../src/main/db/books'
import { countBookSegments, getBookSegments, saveBookSegments, segHashOf } from '../../src/main/db/book-segments'
import {
  formatNumberedRequest,
  parseNumberedTranslations
} from '../../src/main/book-segments'
import {
  batchSegments,
  joinSegmentTranslations,
  nextPdfPage,
  normalizeBookText,
  splitBookSegments,
  splitPdfParagraphs,
  visiblePageKey
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

describe('内容分句', () => {
  it('按句末标点切分，空白归一化', () => {
    expect(splitBookSegments('你好世界。这是第二句！第三句？')).toEqual(['你好世界。', '这是第二句！', '第三句？'])
    expect(splitBookSegments('  Hello   world.  How are you?  ')).toEqual(['Hello world.', 'How are you?'])
    expect(splitBookSegments('   ')).toEqual([])
    expect(splitBookSegments('')).toEqual([])
  })

  it('同样文字在任何排版下切分相同（与页面/字号无关）', () => {
    const a = splitBookSegments('开端的第1段。这是测试文字，只保证每次生成完全相同。')
    const b = splitBookSegments('开端的第1段。这是测试文字，只保证每次生成完全相同。')
    expect(a).toEqual(b)
  })

  it('无标点整页退化为单分句，超长句按长度硬切且仍只与内容有关', () => {
    expect(splitBookSegments('没有标点的一整页')).toEqual(['没有标点的一整页'])
    const long = `前言${'啊'.repeat(3000)}结尾。`
    const parts = splitBookSegments(long)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.join('')).toBe(normalizeBookText(long))
    expect(splitBookSegments(long)).toEqual(parts)
  })

  it('译文按原文顺序拼接（中文不加空格）', () => {
    expect(joinSegmentTranslations(['你好世界。', '这是第二句！'])).toBe('你好世界。这是第二句！')
  })

  it('PDF 视觉行按句末标点组段，空行断段', () => {
    expect(splitPdfParagraphs('第一行没有标点\n第二行结束了。\n第三行新段。')).toEqual([
      '第一行没有标点第二行结束了。',
      '第三行新段。'
    ])
    expect(splitPdfParagraphs('第一段。\n\n第二段。')).toEqual(['第一段。', '第二段。'])
    expect(splitPdfParagraphs('   \n  ')).toEqual([])
    expect(splitPdfParagraphs('')).toEqual([])
    // 英文行之间补空格。
    expect(splitPdfParagraphs('Hello\nworld.')).toEqual(['Hello world.'])
  })

  it('分批装箱不拆分句、不超限', () => {
    const segs = ['a'.repeat(1000), 'b'.repeat(1000), 'c'.repeat(1000)]
    const batches = batchSegments(segs, 2500)
    expect(batches).toEqual([['a'.repeat(1000), 'b'.repeat(1000)], ['c'.repeat(1000)]])
    expect(batchSegments([], 2500)).toEqual([])
  })

  it('视图身份键：PDF 按页码，EPUB 按起点 CFI', () => {
    expect(visiblePageKey({ page: 3 }, true)).toBe('pdf-page-3')
    expect(visiblePageKey({ page: 1, startCfi: 'epubcfi(/6/4!/4/2)' }, false)).toBe('epub-epubcfi(/6/4!/4/2)')
    expect(nextPdfPage({ page: 1, totalPages: 5 }, true)).toBe(2)
    expect(nextPdfPage({ page: 5, totalPages: 5 }, true)).toBeNull()
    expect(nextPdfPage({ page: 2, totalPages: 10 }, false)).toBeNull()
  })
})

describe('编号批量协议', () => {
  it('请求格式一段一行', () => {
    expect(formatNumberedRequest(['甲。', '乙！'])).toBe('1. 甲。\n2. 乙！')
  })

  it('正常回译严格对齐', () => {
    expect(parseNumberedTranslations('1. 译甲。\n2. 译乙！', 2)).toEqual(['译甲。', '译乙！'])
  })

  it('容忍开场白、顿号冒号编号与段内换行续写', () => {
    const raw = '好的，翻译如下：\n1、译甲。\n2：译乙\n续行。\n翻译完毕'
    expect(parseNumberedTranslations(raw, 2)).toEqual(['译甲。', '译乙续行。'])
  })

  it('段数不符、缺段、空译文一律返回 null', () => {
    expect(parseNumberedTranslations('1. 只有一段。', 2)).toBeNull()
    expect(parseNumberedTranslations('1. 甲\n3. 丙', 2)).toBeNull()
    expect(parseNumberedTranslations('1. \n2. 乙', 2)).toBeNull()
    expect(parseNumberedTranslations('这是假的回答。', 2)).toBeNull()
    expect(parseNumberedTranslations('', 1)).toBeNull()
  })

  it('译文正文以数字开头不误判为新段（序号必须递增）', () => {
    const raw = '1. 第一段。\n1984年发生的事。\n2. 第二段。'
    expect(parseNumberedTranslations(raw, 2)).toEqual(['第一段。1984年发生的事。', '第二段。'])
  })
})

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
})

describe('分句缓存（记号）', () => {
  it('写入后按 hash 取回，关闭开关不删除', () => {
    const db = openDatabase(':memory:')
    insertBook(db, book('a'))
    expect(countBookSegments(db, 'a')).toBe(0)
    saveBookSegments(db, [{ bookId: 'a', sourceText: 'Hello world.', translatedText: '你好世界。' }])
    const hash = segHashOf('a', 'Hello world.')
    const got = getBookSegments(db, 'a', [hash])
    expect(got.get(hash)?.translatedText).toBe('你好世界。')
    expect(countBookSegments(db, 'a')).toBe(1)
    setTranslationEnabled(db, 'a', false)
    expect(getBookSegments(db, 'a', [hash]).get(hash)?.translatedText).toBe('你好世界。')
    db.close()
  })

  it('同样文字在不同分批中键相同（改字号复用的基础）', () => {
    const db = openDatabase(':memory:')
    insertBook(db, book('a'))
    saveBookSegments(db, [{ bookId: 'a', sourceText: '第二句！', translatedText: '译二！' }])
    // 模拟改字号后新页面包含迁移过来的旧分句：键一致，直接命中。
    const hash = segHashOf('a', '  第二句！  ')
    expect(getBookSegments(db, 'a', [hash]).has(hash)).toBe(true)
    db.close()
  })

  it('同键重复写入更新译文（upsert），删书级联清理', () => {
    const db = openDatabase(':memory:')
    insertBook(db, book('a'))
    saveBookSegments(db, [{ bookId: 'a', sourceText: 'Hi.', translatedText: '嗨。' }])
    saveBookSegments(db, [{ bookId: 'a', sourceText: 'Hi.', translatedText: '你好。' }])
    expect(getBookSegments(db, 'a', [segHashOf('a', 'Hi.')]).get(segHashOf('a', 'Hi.'))?.translatedText).toBe('你好。')
    expect(countBookSegments(db, 'a')).toBe(1)
    db.prepare('DELETE FROM books WHERE id = ?').run('a')
    expect(countBookSegments(db, 'a')).toBe(0)
    db.close()
  })

  it('v11 退役旧按页缓存表', () => {
    const db = openDatabase(':memory:')
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      (r) => r.name
    )
    expect(names).toContain('book_segments')
    expect(names).not.toContain('book_translations')
    db.close()
  })
})
