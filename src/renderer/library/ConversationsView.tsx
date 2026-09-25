import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BookRecord, ConversationWithBook } from '@shared/types'
import ConfirmDialog from '../ConfirmDialog'
import { cfiChapterKey, compareCfi } from '../reader/cfi'
import { useBookCovers } from './useBookCovers'

interface Props {
  onBack: () => void
}

function relativeDate(createdAt: number): string {
  const days = Math.floor(Math.max(0, Date.now() - createdAt) / 86_400_000)
  if (days === 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 30) return `${days}天前`
  if (days < 365) return `${Math.floor(days / 30)}个月前`
  return `${Math.floor(days / 365)}年前`
}

export default function ConversationsView({ onBack }: Props) {
  const [books, setBooks] = useState<BookRecord[]>([])
  const [conversations, setConversations] = useState<ConversationWithBook[]>([])
  const [activeBookId, setActiveBookId] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [confirming, setConfirming] = useState(false)
  const requestSequence = useRef(0)
  const mounted = useRef(true)
  const coverUrls = useBookCovers(books)

  const refresh = useCallback(async () => {
    const request = ++requestSequence.current
    try {
      const [loadedBooks, rows] = await Promise.all([
        window.api.listBooks(),
        window.api.listAllConversations()
      ])
      if (!mounted.current || request !== requestSequence.current) return
      setBooks(loadedBooks)
      setConversations(rows)
      setLoading(false)
      setSelected((current) => {
        const valid = new Set(rows.map((row) => row.id))
        return new Set([...current].filter((id) => valid.has(id)))
      })
    } catch (reason) {
      if (mounted.current && request === requestSequence.current) {
        setLoading(false)
        setError(reason instanceof Error ? reason.message : '对话读取失败')
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

  const activeBook = books.find((book) => book.id === activeBookId)
  const bookRows = useMemo(
    () => conversations.filter((row) => row.bookId === activeBookId),
    [activeBookId, conversations]
  )
  const chapters = useMemo(() => {
    const sorted = [...bookRows].sort((a, b) => {
      try { return compareCfi(a.startCfi, b.startCfi) }
      catch { return a.createdAt - b.createdAt }
    })
    const grouped = new Map<string, { label: string; rows: ConversationWithBook[] }>()
    for (const row of sorted) {
      let key: string
      try { key = cfiChapterKey(row.startCfi) }
      catch { key = row.chapterLabel ?? '未命名章节' }
      const group = grouped.get(key)
      if (group) group.rows.push(row)
      else grouped.set(key, { label: row.chapterLabel ?? '未命名章节', rows: [row] })
    }
    return [...grouped.entries()]
  }, [bookRows])

  function toggle(id: string): void {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleGroup(rows: ConversationWithBook[]): void {
    setSelected((current) => {
      const next = new Set(current)
      const allSelected = rows.every((row) => next.has(row.id))
      for (const row of rows) {
        if (allSelected) next.delete(row.id)
        else next.add(row.id)
      }
      return next
    })
  }

  async function deleteSelected(): Promise<void> {
    const ids = [...selected]
    if (ids.length === 0) return
    setBusy(true)
    setError(null)
    try {
      await window.api.deleteConversations(ids)
      if (!mounted.current) return
      setSelected(new Set())
      setConfirming(false)
      await refresh()
    } catch (reason) {
      if (mounted.current) {
        setConfirming(false)
        setError(reason instanceof Error ? reason.message : '对话删除失败')
      }
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  function openBook(id: string): void {
    setActiveBookId(id)
    setSelected(new Set())
  }

  function backToShelf(): void {
    setActiveBookId(null)
    setSelected(new Set())
  }

  const allSelected = bookRows.length > 0 && bookRows.every((row) => selected.has(row.id))

  return (
    <main className="conversations" data-testid="conversations-view">
      <header className={`conversations__header${activeBook ? '' : ' conversations__header--shelf'}`}>
        <button type="button" className="button--ghost" onClick={activeBook ? backToShelf : onBack}>
          {activeBook ? '← 对话书架' : '← 返回书架'}
        </button>
        <div>
          <p className="eyebrow">{activeBook ? '按章节整理' : '阅读记录'}</p>
          <h1>{activeBook?.title ?? '对话书架'}</h1>
        </div>
        {activeBook && <button type="button" className="button--danger-subtle" data-testid="conversation-delete" disabled={busy || selected.size === 0} onClick={() => setConfirming(true)}>
          删除选中{selected.size > 0 ? `（${selected.size}）` : ''}
        </button>}
      </header>
      {error && <p className="conversations__error" data-testid="conversations-error">{error}</p>}
      {!activeBook ? (
        <section className="conversations__shelf" aria-label="按书管理对话">
          <div className="conversations__shelf-intro">
            <p>选择一本书，查看按章节整理的对话。</p>
            <span className="library__count">{books.length} 本书 · {conversations.length} 个对话</span>
          </div>
          {loading ? <div className="empty">正在整理书架…</div> : books.length === 0 ? <div className="empty">书架是空的，先添加一本书吧。</div> : (
            <div className="library__grid">
              {books.map((book) => {
                const count = conversations.filter((row) => row.bookId === book.id).length
                return <div className="book-card" data-testid="conversation-book" key={book.id}>
                  <button type="button" className="book-card__open" aria-label={`管理《${book.title}》的对话`} onClick={() => openBook(book.id)}>
                    <div className="book-card__cover">
                      {coverUrls[book.id] ? <img src={coverUrls[book.id]} alt="" /> : book.title}
                    </div>
                    <div className="book-card__title">{book.title}</div>
                    <div className="book-card__author">{book.author ?? '佚名'}</div>
                    <span className="conversation-book__count">{count} 个对话</span>
                  </button>
                </div>
              })}
            </div>
          )}
        </section>
      ) : <div className="conversations__detail">
        {bookRows.length === 0 ? <div className="empty">这本书还没有对话。</div> : (
          <>
            <div className="conversations__toolbar">
              <label className="conversations__select-all">
                <input type="checkbox" checked={allSelected} onChange={() => toggleGroup(bookRows)} />
                全选本书
              </label>
              <span>{chapters.length} 个章节 · {bookRows.length} 个对话</span>
            </div>
            <div className="conversations__content">{chapters.map(([key, group], index) => {
              const groupSelected = group.rows.length > 0 && group.rows.every((row) => selected.has(row.id))
              return <details className="conversation-group" data-testid="chapter-group" key={`${activeBook.id}:${key}`} open={index === 0}>
                <summary data-testid="chapter-toggle">
                  <span>{group.label}</span>
                  <small>{group.rows.length} 个对话</small>
                </summary>
                <label className="conversation-group__select">
                  <input type="checkbox" checked={groupSelected} onChange={() => toggleGroup(group.rows)} />
                  选择本章
                </label>
                {group.rows.map((conversation) => (
                  <label className={`conversation-row${selected.has(conversation.id) ? ' conversation-row--selected' : ''}`} data-testid="conversation-row" key={conversation.id}>
                    <input type="checkbox" checked={selected.has(conversation.id)} onChange={() => toggle(conversation.id)} />
                    <span className="conversation-row__text">
                      <span>「{conversation.excerpt}」{conversation.mergedEndCfi ? ' · 含下一屏' : ''}</span>
                      <small>{conversation.messageCount} 条消息 · {relativeDate(conversation.createdAt)}</small>
                    </span>
                  </label>
                ))}
              </details>
            })}</div>
          </>
        )}
      </div>}
      {confirming && <ConfirmDialog
        title="删除选中的对话？"
        message={`确定删除选中的 ${selected.size} 个对话吗？其中的消息也会一并删除，且无法恢复。`}
        confirmLabel="确认删除"
        onCancel={() => setConfirming(false)}
        onConfirm={() => void deleteSelected()}
        busy={busy}
        testId="confirm-conversations-delete"
        confirmTestId="confirm-conversations-delete-yes"
      />}
    </main>
  )
}
