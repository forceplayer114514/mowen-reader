import type { AnnotationRecord } from '@shared/types'
import type { HighlightRecord } from '@shared/highlight-types'
import type { ExcerptMarkdownGroup, ExcerptMarkdownItem } from '@shared/excerpts'
import { cfiChapterKey, compareCfi } from '../reader/cfi'

export type { ExcerptMarkdownGroup, ExcerptMarkdownItem }

export interface ExcerptItem extends ExcerptMarkdownItem {
  id: string
  bookId: string
  startCfi: string
  cfiRange: string
  updatedAt: number | null
}

/** 高亮与批注合并为同一列表:同一选区可能同时有高亮和批注,两者都保留。 */
export function mergeExcerpts(highlights: HighlightRecord[], annotations: AnnotationRecord[]): ExcerptItem[] {
  const highlightItems: ExcerptItem[] = highlights.map((row) => ({
    kind: 'highlight',
    id: row.id,
    bookId: row.bookId,
    startCfi: row.startCfi,
    cfiRange: row.cfiRange,
    quote: row.quote,
    note: null,
    chapterLabel: null,
    createdAt: row.createdAt,
    updatedAt: null
  }))
  const annotationItems: ExcerptItem[] = annotations.map((row) => ({
    kind: 'annotation',
    id: row.id,
    bookId: row.bookId,
    startCfi: row.startCfi,
    cfiRange: row.cfiRange,
    quote: row.quote,
    note: row.content,
    chapterLabel: row.chapterLabel,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }))
  return sortExcerpts([...highlightItems, ...annotationItems])
}

/** 按原文位置(CFI 全序)排序;CFI 解析失败时按创建时间兜底,不丢数据。 */
export function sortExcerpts(items: ExcerptItem[]): ExcerptItem[] {
  return [...items].sort((a, b) => {
    try {
      const order = compareCfi(a.startCfi, b.startCfi)
      if (order !== 0) return order
    } catch { /* 非 EPUB 定位符等解析失败时按时间排 */ }
    return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  })
}

/** 在原文引用与批注正文内搜索;空查询返回全部。 */
export function filterExcerpts(items: ExcerptItem[], query: string): ExcerptItem[] {
  const term = query.trim().normalize('NFKC').toLowerCase()
  if (!term) return items
  return items.filter((item) =>
    `${item.quote} ${item.note ?? ''} ${item.chapterLabel ?? ''}`.normalize('NFKC').toLowerCase().includes(term)
  )
}

/** 按章节分组:优先用 CFI 章节键保证顺序,键解析失败时按 chapterLabel 收拢。 */
export function groupExcerptsByChapter(items: ExcerptItem[]): [string, { label: string; rows: ExcerptItem[] }][] {
  const grouped = new Map<string, { label: string; rows: ExcerptItem[] }>()
  for (const row of sortExcerpts(items)) {
    let key: string
    try {
      key = `cfi:${cfiChapterKey(row.startCfi)}`
    } catch {
      key = `label:${row.chapterLabel ?? '未命名章节'}`
    }
    const group = grouped.get(key)
    if (group) {
      group.rows.push(row)
      if (group.label === '未命名章节' && row.chapterLabel) group.label = row.chapterLabel
    } else {
      grouped.set(key, { label: row.chapterLabel ?? '未命名章节', rows: [row] })
    }
  }
  return [...grouped.entries()]
}
