import { describe, expect, it } from 'vitest'
import { buildExcerptsMarkdown, sanitizeExcerptFilename } from '../../src/shared/excerpts'
import {
  filterExcerpts,
  groupExcerptsByChapter,
  mergeExcerpts,
  sortExcerpts,
  type ExcerptItem
} from '../../src/renderer/library/excerpts'

function highlight(over: Partial<ExcerptItem> = {}): ExcerptItem {
  return {
    kind: 'highlight', id: 'h1', bookId: 'book', startCfi: 'epubcfi(/6/2!/4/2/1:0)',
    cfiRange: 'epubcfi(/6/2!/4/2,/1:0,/1:12)', quote: '原文引用', note: null,
    chapterLabel: null, createdAt: 100, updatedAt: null, ...over
  }
}

describe('摘录合并与排序', () => {
  it('高亮与批注合并,同一选区两者都保留,按 CFI 位置排序', () => {
    const merged = mergeExcerpts(
      [
        { id: 'h-late', bookId: 'book', startCfi: 'epubcfi(/6/4!/4/2/1:0)',
          cfiRange: 'epubcfi(/6/4!/4/2,/1:0,/1:5)', quote: '后', createdAt: 1 },
        { id: 'h-early', bookId: 'book', startCfi: 'epubcfi(/6/2!/4/2/1:0)',
          cfiRange: 'epubcfi(/6/2!/4/2,/1:0,/1:5)', quote: '前', createdAt: 9 }
      ],
      [
        { id: 'a1', bookId: 'book', startCfi: 'epubcfi(/6/2!/4/4/1:0)',
          cfiRange: 'epubcfi(/6/2!/4/4,/1:0,/1:5)', quote: '中', chapterLabel: '第一章',
          content: '想法', createdAt: 5, updatedAt: 6 }
      ]
    )
    expect(merged.map((row) => row.id)).toEqual(['h-early', 'a1', 'h-late'])
    expect(merged.find((row) => row.id === 'a1')).toMatchObject({ kind: 'annotation', note: '想法' })
  })

  it('CFI 非法时按创建时间兜底,不丢数据不抛错', () => {
    const rows = sortExcerpts([highlight({ id: 'b', startCfi: '坏定位', createdAt: 2 }), highlight({ id: 'a', startCfi: '也坏', createdAt: 1 })])
    expect(rows.map((row) => row.id)).toEqual(['a', 'b'])
  })
})

describe('摘录搜索', () => {
  it('在原文引用、批注正文与章节名内大小写无关地匹配', () => {
    const rows = [
      highlight({ id: 'q', quote: 'Quoted Sentence' }),
      highlight({ id: 'n', quote: '不相关', note: '我的想法 NOTE', chapterLabel: null }),
      highlight({ id: 'c', quote: '不相关', chapterLabel: 'Chapter Two' })
    ]
    expect(filterExcerpts(rows, 'quoted').map((row) => row.id)).toEqual(['q'])
    expect(filterExcerpts(rows, 'note').map((row) => row.id)).toEqual(['n'])
    expect(filterExcerpts(rows, 'chapter two').map((row) => row.id)).toEqual(['c'])
    expect(filterExcerpts(rows, '  ')).toHaveLength(3)
  })
})

describe('摘录按章节分组', () => {
  it('同章节收拢一组并保持原文顺序,非法 CFI 按章节名收拢', () => {
    const groups = groupExcerptsByChapter([
      highlight({ id: 'b2', startCfi: 'epubcfi(/6/4!/4/2/1:0)', chapterLabel: '第二章', createdAt: 2 }),
      highlight({ id: 'a2', startCfi: 'epubcfi(/6/2!/4/4/1:0)', chapterLabel: '第一章', createdAt: 3 }),
      highlight({ id: 'a1', startCfi: 'epubcfi(/6/2!/4/2/1:0)', chapterLabel: '第一章', createdAt: 1 }),
      highlight({ id: 'x', startCfi: '坏定位', chapterLabel: '附录', createdAt: 4 })
    ])
    expect(groups).toHaveLength(3)
    expect(groups[0][1].rows.map((row) => row.id)).toEqual(['a1', 'a2'])
    expect(groups[0][1].label).toBe('第一章')
    expect(groups[2][0]).toBe('label:附录')
  })
})

describe('摘录 Markdown 导出排版', () => {
  it('标题/作者/计数/引用/批注/章节齐全,空书有兜底', () => {
    const markdown = buildExcerptsMarkdown('三体', '刘慈欣', [
      { label: '第一章', rows: [
        { kind: 'highlight', quote: '给岁月以文明', note: null, chapterLabel: '第一章', createdAt: 1_700_000_000_000 },
        { kind: 'annotation', quote: '黑暗森林', note: '细思极恐', chapterLabel: '第一章', createdAt: 1_700_000_000_000 }
      ] }
    ])
    expect(markdown).toContain('# 《三体》摘录')
    expect(markdown).toContain('刘慈欣')
    expect(markdown).toContain('共 2 条（高亮 1 · 批注 1）')
    expect(markdown).toContain('## 第一章')
    expect(markdown).toContain('> 给岁月以文明')
    expect(markdown).toContain('批注：细思极恐')
    expect(buildExcerptsMarkdown('空书', null, [])).toContain('暂无摘录')
  })

  it('标题里的 Markdown 字符被转义,不破坏排版', () => {
    const markdown = buildExcerptsMarkdown('# 标题', null, [])
    expect(markdown.split('\n')[0]).toBe('# 《\\# 标题》摘录')
  })
})

describe('导出文件名清洗', () => {
  it('去路径分隔符与非法字符,防目录穿越', () => {
    expect(sanitizeExcerptFilename('../../etc/passwd')).toBe('_.._etc_passwd')
    expect(sanitizeExcerptFilename('书名：第一章/序言*？')).toBe('书名：第一章_序言_？')
    expect(sanitizeExcerptFilename('  ')).toBe('excerpts')
    expect(sanitizeExcerptFilename('a'.repeat(200))).toHaveLength(80)
  })
})
