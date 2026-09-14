import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConversationWithBook } from '@shared/types'

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
  const [conversations, setConversations] = useState<ConversationWithBook[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const requestSequence = useRef(0)
  const mounted = useRef(true)

  const refresh = useCallback(async () => {
    const request = ++requestSequence.current
    try {
      const rows = await window.api.listAllConversations()
      if (!mounted.current || request !== requestSequence.current) return
      setConversations(rows)
      setSelected((current) => {
        const valid = new Set(rows.map((row) => row.id))
        return new Set([...current].filter((id) => valid.has(id)))
      })
    } catch (reason) {
      if (mounted.current && request === requestSequence.current) {
        setError(reason instanceof Error ? reason.message : '对话读取失败')
      }
    }
  }, [mounted, requestSequence])

  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => {
      mounted.current = false
      requestSequence.current += 1
    }
  }, [refresh])

  const groups = useMemo(() => {
    const grouped = new Map<string, { title: string; rows: ConversationWithBook[] }>()
    for (const conversation of conversations) {
      const group = grouped.get(conversation.bookId)
      if (group) group.rows.push(conversation)
      else grouped.set(conversation.bookId, { title: conversation.bookTitle, rows: [conversation] })
    }
    return [...grouped.entries()]
  }, [conversations])

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
    if (!window.confirm(`确定删除选中的 ${ids.length} 个对话吗？对话中的消息也会一并删除，且无法恢复。`)) return
    setBusy(true)
    setError(null)
    try {
      await window.api.deleteConversations(ids)
      if (!mounted.current) return
      setSelected(new Set())
      await refresh()
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : '对话删除失败')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const allSelected = conversations.length > 0 && conversations.every((row) => selected.has(row.id))

  return (
    <main className="conversations" data-testid="conversations-view">
      <header className="conversations__header">
        <button type="button" onClick={onBack}>← 返回书架</button>
        <h1>对话管理</h1>
        <button type="button" data-testid="conversation-delete" disabled={busy || selected.size === 0} onClick={() => void deleteSelected()}>
          删除选中{selected.size > 0 ? `（${selected.size}）` : ''}
        </button>
      </header>
      {error && <p className="conversations__error" data-testid="conversations-error">{error}</p>}
      {conversations.length === 0 ? (
        <p className="empty">还没有对话。</p>
      ) : (
        <>
          <label className="conversations__select-all">
            <input type="checkbox" checked={allSelected} onChange={() => toggleGroup(conversations)} />
            全选
          </label>
          {groups.map(([bookId, group]) => {
            const groupSelected = group.rows.length > 0 && group.rows.every((row) => selected.has(row.id))
            return (
              <section className="conversation-group" key={bookId}>
                <h2>{group.title}</h2>
                <label className="conversation-group__select">
                  <input type="checkbox" checked={groupSelected} onChange={() => toggleGroup(group.rows)} />
                  选择本书
                </label>
                {group.rows.map((conversation) => (
                  <label className="conversation-row" data-testid="conversation-row" key={conversation.id}>
                    <input type="checkbox" checked={selected.has(conversation.id)} onChange={() => toggle(conversation.id)} />
                    <span className="conversation-row__text">
                      <span>
                        {conversation.chapterLabel ?? '未命名章节'}{conversation.mergedEndCfi ? '（+下一页）' : ''} ·「{conversation.excerpt}」
                      </span>
                      <small>{conversation.messageCount} 条　{relativeDate(conversation.createdAt)}</small>
                    </span>
                  </label>
                ))}
              </section>
            )
          })}
        </>
      )}
    </main>
  )
}
