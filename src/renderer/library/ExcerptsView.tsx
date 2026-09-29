import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BookRecord } from '@shared/types'
import { buildExcerptsMarkdown, sanitizeExcerptFilename } from '@shared/excerpts'
import { filterExcerpts, groupExcerptsByChapter, mergeExcerpts, type ExcerptItem } from './excerpts'
import { useBookCovers } from './useBookCovers'

interface Props {
  onBack: () => void
  onOpenAt: (book: BookRecord, cfi: string) => void
}

function relativeDate(createdAt: number): string {
  const days = Math.floor(Math.max(0, Date.now() - createdAt) / 86_400_000)
  if (days === 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 30) return `${days}天前`
  if (days < 365) return `${Math.floor(days / 30)}个月前`
  return `${Math.floor(days / 365)}年前`
}

export default function ExcerptsView({ onBack, onOpenAt }: Props) {
  const [books, setBooks] = useState<BookRecord[]>([])
  const [byBook, setByBook] = useState<Map<string, ExcerptItem[]>>(new Map())
  const [activeBookId, setActiveBookId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportNotice, setExportNotice] = useState<string | null>(null)
  const requestSequence = useRef(0)
  const mounted = useRef(true)
  const coverUrls = useBookCovers(books)

  const refresh = useCallback(async () => {
    const request = ++requestSequence.current
    try {
      const loadedBooks = await window.api.listBooks()
      if (!mounted.current || request !== requestSequence.current) return
      setBooks(loadedBooks)
      // 按书复用现有的 listHighlights / listAnnotations,不新增跨书查询通道。
      const entries = await Promise.all(loadedBooks.map(async (book): Promise<[string, ExcerptItem[]]> => {
        const [highlights, annotations] = await Promise.all([
          window.api.listHighlights(book.id),
          window.api.listAnnotations(book.id)
        ])
        return [book.id, mergeExcerpts(highlights, annotations)]
      }))
      if (!mounted.current || request !== requestSequence.current) return
      setByBook(new Map(entries.map(([id, items]) => [id, items])))
      setLoading(false)
      setError(null)
    } catch (reason) {
      if (mounted.current && request === requestSequence.current) {
        setLoading(false)
        setError(reason instanceof Error ? reason.message : '摘录读取失败')
      }
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => {
      mounted.current = false
      requestSequence.current += 1
    }
  }, [refresh])

  const term = query.trim()
  const shelfBooks = useMemo(() => {
    if (!term) return books
    const lowered = term.normalize('NFKC').toLowerCase()
    return books.filter((book) => {
      if (`${book.title} ${book.author ?? ''}`.normalize('NFKC').toLowerCase().includes(lowered)) return true
      return (byBook.get(book.id) ?? []).some((item) =>
        `${item.quote} ${item.note ?? ''} ${item.chapterLabel ?? ''}`.normalize('NFKC').toLowerCase().includes(lowered)
      )
    })
  }, [books, byBook, term])

  const activeBook = books.find((book) => book.id === activeBookId) ?? null
  const activeItems = activeBookId ? (byBook.get(activeBookId) ?? []) : []
  const visibleItems = useMemo(() => term && `${activeBook?.title ?? ''} ${activeBook?.author ?? ''}`.normalize('NFKC').toLowerCase().includes(term.normalize('NFKC').toLowerCase())
    ? activeItems : filterExcerpts(activeItems, query), [activeItems, activeBook, query, term])
  const chapters = useMemo(() => groupExcerptsByChapter(visibleItems), [visibleItems])
  const totalCount = [...byBook.values()].reduce((sum, items) => sum + items.length, 0)

  function openBook(id: string): void {
    setActiveBookId(id)
    setExportNotice(null)
  }

  function backToShelf(): void {
    setActiveBookId(null)
    setExportNotice(null)
  }

  async function exportCurrentBook(): Promise<void> {
    if (!activeBook || exporting) return
    setExporting(true)
    setExportNotice(null)
    try {
      const groups = groupExcerptsByChapter(activeItems).map(([, group]) => ({
        label: group.label,
        rows: group.rows.map((row) => ({
          kind: row.kind, quote: row.quote, note: row.note,
          chapterLabel: row.chapterLabel, createdAt: row.createdAt
        }))
      }))
      const markdown = buildExcerptsMarkdown(activeBook.title, activeBook.author, groups)
      const result = await window.api.exportExcerpts({
        suggestedName: `${sanitizeExcerptFilename(activeBook.title)}.md`,
        markdown
      })
      if (mounted.current) {
        setExportNotice(result.saved ? '已导出 Markdown,可在选择的文件夹中找到。' : '已取消导出。')
      }
    } catch (reason) {
      if (mounted.current) {
        setExportNotice(reason instanceof Error ? reason.message : '导出失败,请重试。')
      }
    } finally {
      if (mounted.current) setExporting(false)
    }
  }

  return (
    <main className="conversations excerpts" data-testid="excerpts-view">
      <header className={`conversations__header${activeBook ? '' : ' conversations__header--shelf'}`}>
        <button type="button" className="button--ghost" onClick={activeBook ? backToShelf : onBack}>
          {activeBook ? '← 摘录书架' : '← 返回书架'}
        </button>
        <div>
          <p className="eyebrow">{activeBook ? '按章节整理' : '高亮与批注'}</p>
          <h1>{activeBook?.title ?? '摘录中心'}</h1>
        </div>
        {activeBook && (
          <button type="button" className="button--secondary" data-testid="excerpt-export"
            disabled={exporting || activeItems.length === 0} onClick={() => void exportCurrentBook()}>
            {exporting ? '导出中…' : '导出 Markdown'}
          </button>
        )}
      </header>
      {error && <p className="conversations__error" data-testid="excerpts-error">{error}</p>}
      {exportNotice && <p className="excerpts__notice" data-testid="excerpt-export-status" role="status">{exportNotice}</p>}
      <div className="conversations__search">
        <input type="search" data-testid="excerpt-search" aria-label="搜索摘录"
          placeholder="搜索原文引用或批注…" value={query}
          onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setQuery('') }} />
        {query && <button type="button" className="button--ghost" onClick={() => setQuery('')}>清空</button>}
      </div>
      {!activeBook ? (
        <section className="conversations__shelf" aria-label="按书管理摘录">
          <div className="conversations__shelf-intro">
            <p>选择一本书，查看按章节整理的高亮与批注。</p>
            <span className="library__count">{books.length} 本书 · {totalCount} 条摘录</span>
          </div>
          {loading ? <div className="empty">正在整理摘录…</div>
            : books.length === 0 ? <div className="empty">书架是空的，先添加一本书吧。</div>
            : shelfBooks.length === 0 ? <div className="empty">没有找到匹配的摘录。</div> : (
            <div className="library__grid">
              {shelfBooks.map((book) => {
                const count = (byBook.get(book.id) ?? []).length
                return <div className="book-card" data-testid="excerpt-book" key={book.id}>
                  <button type="button" className="book-card__open" aria-label={`查看《${book.title}》的摘录`} onClick={() => openBook(book.id)}>
                    <div className="book-card__cover">
                      {coverUrls[book.id] ? <img src={coverUrls[book.id]} alt="" /> : book.title}
                    </div>
                    <div className="book-card__title">{book.title}</div>
                    <div className="book-card__author">{book.author ?? '佚名'}</div>
                    <span className="conversation-book__count">{count} 条摘录</span>
                  </button>
                </div>
              })}
            </div>
          )}
        </section>
      ) : (
        <div className="conversations__detail">
          {visibleItems.length === 0 ? (
            <div className="empty">{term ? '没有找到匹配的摘录。' : '这本书还没有高亮或批注，去正文里划选一段吧。'}</div>
          ) : (
            <>
              <div className="conversations__toolbar">
                <span>{chapters.length} 个章节 · {visibleItems.length} 条摘录</span>
              </div>
              <div className="conversations__content">{chapters.map(([key, group], index) => (
                <details className="conversation-group" data-testid="excerpt-chapter" key={`${activeBook.id}:${key}`} open={index === 0}>
                  <summary data-testid="chapter-toggle">
                    <span>{group.label}</span>
                    <small>{group.rows.length} 条</small>
                  </summary>
                  {group.rows.map((item) => (
                    <div className="conversation-row excerpt-row" data-testid="excerpt-row" key={item.id}>
                      <span className="excerpt-row__body">
                        <span className={`excerpt-row__kind excerpt-row__kind--${item.kind}`}>
                          {item.kind === 'annotation' ? '批注' : '高亮'}
                        </span>
                        <span className="excerpt-row__quote">「{item.quote}」</span>
                        {item.note && <span className="excerpt-row__note">{item.note}</span>}
                        <small>{relativeDate(item.createdAt)}</small>
                      </span>
                      <button type="button" className="button--ghost" aria-label="回到原文"
                        onClick={() => onOpenAt(activeBook, item.startCfi)}>定位原文</button>
                    </div>
                  ))}
                </details>
              ))}</div>
            </>
          )}
        </div>
      )}
    </main>
  )
}
