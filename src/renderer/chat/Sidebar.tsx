import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  BookRecord,
  ConversationWithCount,
  MessageRecord,
  QuoteRecord
} from '@shared/types'
import { conversationsOnPage } from '../reader/anchor'
import { cfiChapterKey } from '../reader/cfi'
import type { ReaderEngine, TocItem, VisibleRange } from '../reader/types'
import type { SelectionStore } from '../reader/selection'
import ConversationView from './ConversationView'
import HistoryList from './HistoryList'
import MergeButton from './MergeButton'
import { useChat } from './useChat'
import { DEFAULT_CONTEXT_LIMIT, DEFAULT_SYSTEM_PROMPT } from '../settings/defaults'

interface Props {
  book: BookRecord
  engine: ReaderEngine | null
  visible: VisibleRange | null
  toc: TocItem[]
  selection: SelectionStore | null
  restoring?: boolean
  spread?: boolean
  onSetSpread?: (on: boolean) => Promise<void>
}

export function mergeLoadedMessages(
  loaded: MessageRecord[],
  local: MessageRecord[],
  conversationId?: string
): MessageRecord[] {
  const id = conversationId ?? loaded[0]?.conversationId ?? local[0]?.conversationId
  const localForConversation = id
    ? local.filter((message) => message.conversationId === id)
    : local
  const loadedIds = new Set(loaded.map((message) => message.id))
  return [
    ...loaded,
    ...localForConversation.filter((message) => !loadedIds.has(message.id))
  ]
}

export default function Sidebar({
  book,
  engine,
  visible,
  toc,
  selection,
  restoring = false,
  spread = false,
  onSetSpread
}: Props) {
  const [conversations, setConversations] = useState<ConversationWithCount[]>([])
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [quotes, setQuotes] = useState<QuoteRecord[]>([])
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT)
  const [contextLimit, setContextLimit] = useState(DEFAULT_CONTEXT_LIMIT)
  const [width, setWidth] = useState(340)
  const [collapsed, setCollapsed] = useState(false)
  const [conversationEndCfi, setConversationEndCfi] = useState<string | null>(null)
  const [mergedEndCfi, setMergedEndCfi] = useState<string | null>(null)
  const [mergedVisible, setMergedVisible] = useState<VisibleRange | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const conversationsRequestRef = useRef(0)
  const pageKeyRef = useRef(visible ? `${visible.startCfi}|${visible.endCfi}` : '')
  const chatRef = useRef<ReturnType<typeof useChat> | null>(null)
  const mergeInProgressRef = useRef(false)
  const mergeStartEndRef = useRef<string | null>(null)

  const loadConversations = useCallback(async () => {
    const request = ++conversationsRequestRef.current
    try {
      const loaded = await window.api.listConversations(book.id)
      if (request === conversationsRequestRef.current) setConversations(loaded)
    } catch { /* keep the last usable list */ }
  }, [book.id])

  useEffect(() => {
    void loadConversations()
    void Promise.all([
      window.api.getSetting('llmSystemPrompt'),
      window.api.getSetting('llmContextLimit'),
      window.api.getSetting('sidebarWidth')
    ]).then(([prompt, limit, savedWidth]) => {
      if (prompt) setSystemPrompt(prompt)
      const parsedLimit = Number(limit)
      if (Number.isFinite(parsedLimit) && parsedLimit > 0) setContextLimit(parsedLimit)
      const parsedWidth = Number(savedWidth)
      if (Number.isFinite(parsedWidth) && parsedWidth >= 260 && parsedWidth <= 600) {
        setWidth(parsedWidth)
      }
    }).catch(() => {})
    return () => { conversationsRequestRef.current += 1 }
  }, [loadConversations])

  useEffect(() => {
    if (!selection) {
      setQuotes([])
      return
    }
    setQuotes(selection.list())
    return selection.subscribe(setQuotes)
  }, [selection])

  const chapterConversations = useMemo(() => {
    if (!visible) return []
    let chapterKey: string
    try {
      chapterKey = cfiChapterKey(visible.startCfi)
    } catch {
      return []
    }
    return conversations.filter((conversation) => {
      if (conversation.id === conversationId) return false
      try {
        return cfiChapterKey(conversation.startCfi) === chapterKey
      } catch {
        return false
      }
    })
  }, [conversations, conversationId, visible])

  useEffect(() => {
    if (!visible) {
      setConversationId(null)
      return
    }
    const onPage = conversationsOnPage(conversations, visible.startCfi, visible.endCfi)
    setConversationId((current) =>
      current && onPage.some((conversation) => conversation.id === current)
        ? current
        : onPage.at(-1)?.id ?? null
    )
  }, [conversations, visible])

  const chat = useChat({
    book,
    visible: spread ? (mergedVisible ?? visible) : visible,
    toc,
    systemPrompt,
    contextLimit,
    conversationId,
    conversationEndCfi,
    mergedEndCfi,
    onConversationCreated: async (id, createdMergedEndCfi) => {
      setConversationId(id)
      if (createdMergedEndCfi) {
        try {
          await window.api.setConversationMerge(id, createdMergedEndCfi)
        } catch {
          setError('合并范围保存失败,当前对话仍会继续发送')
        }
      }
      void loadConversations()
    },
    getQuotes: () => selection?.list() ?? quotes,
    clearQuotes: () => selection?.clear()
  })
  chatRef.current = chat

  useEffect(() => {
    if (!pageKeyRef.current && visible) {
      pageKeyRef.current = `${visible.startCfi}|${visible.endCfi}`
    }
  }, [visible])

  useEffect(() => {
    if (!engine) return
    let cancelled = false
    pageKeyRef.current = visible ? `${visible.startCfi}|${visible.endCfi}` : ''
    const off = engine.onRelocated(() => {
      if (cancelled || restoring) return
      void engine.getVisible().then((next) => {
        if (cancelled || restoring) return
        const nextKey = `${next.startCfi}|${next.endCfi}`
        const previousKey = pageKeyRef.current
        pageKeyRef.current = nextKey
        if (mergeInProgressRef.current) return
        if (!previousKey || previousKey === nextKey) return
        // Page changes own the current conversation lifecycle. stop() keeps a
        // partial answer eligible for persistence; the id change then prevents
        // it from entering the new page's UI.
        chatRef.current?.stop()
        setConversationId(null)
        chatRef.current?.setMessages([])
        setConversationEndCfi(null)
        setMergedEndCfi(null)
        setMergedVisible(null)
        mergeStartEndRef.current = null
        selection?.clear()
      }).catch(() => {})
    })
    return () => {
      cancelled = true
      off()
    }
  }, [engine, restoring, selection])

  useEffect(() => {
    chat.setMessages((current) =>
      conversationId ? current.filter((message) => message.conversationId === conversationId) : []
    )
    if (!conversationId) {
      return
    }
    let cancelled = false
    void window.api.listMessages(conversationId).then((messages: MessageRecord[]) => {
      // A newly created conversation notifies after its user message is stored, but
      // keep a local message if an older/empty read races that notification.
      if (!cancelled) chat.setMessages((local) => mergeLoadedMessages(messages, local, conversationId))
    }).catch(() => {
      if (!cancelled) chat.setMessages((local) => local)
    })
    return () => {
      cancelled = true
    }
  }, [conversationId])

  function selectConversation(id: string): void {
    setConversationId(id)
    chat.setMessages([])
    setShowAll(false)
  }

  function newConversation(): void {
    if (chat.messages.length === 0) return
    setError(null)
    chat.stop()
    if (chat.messages.length > 0) {
      const keep = window.confirm('保留本页当前对话?')
      if (!keep) {
        const id = conversationId ?? chat.messages[0]?.conversationId
        if (id) {
          void window.api.deleteConversations([id])
            .then(loadConversations)
            .catch(() => setError('对话删除失败，原对话仍会保留，请稍后重试'))
        }
      }
    }
    setConversationId(null)
    chat.setMessages([])
    selection?.clear()
  }

  async function mergeNextPage(): Promise<void> {
    if (!engine || spread || mergeInProgressRef.current) return
    if (!visible) return
    const originalPageKey = `${visible.startCfi}|${visible.endCfi}`
    mergeInProgressRef.current = true
    mergeStartEndRef.current = visible.endCfi
    setConversationEndCfi(visible.endCfi)
    try {
      if (onSetSpread) await onSetSpread(true)
      else await engine.setSpread(true)
      const merged = await engine.getVisible()
      pageKeyRef.current = `${merged.startCfi}|${merged.endCfi}`
      setMergedEndCfi(merged.endCfi)
      setMergedVisible(merged)
      if (conversationId) {
        await window.api.setConversationMerge(conversationId, merged.endCfi)
        await loadConversations()
      }
    } catch {
      setError('合并下一页失败，请稍后重试')
      setMergedEndCfi(null)
      setMergedVisible(null)
      setConversationEndCfi(null)
      mergeStartEndRef.current = null
      try {
        if (onSetSpread) await onSetSpread(false)
        else await engine.setSpread(false)
      } catch { /* keep the original error */ }
      pageKeyRef.current = originalPageKey
    } finally {
      mergeStartEndRef.current = null
      mergeInProgressRef.current = false
    }
  }

  function toggleCollapsed(): void {
    setCollapsed((old) => !old)
    void window.api.setSetting('sidebarWidth', String(width)).catch(() => {})
  }

  if (collapsed) {
    return (
      <aside className="sidebar sidebar--collapsed" data-testid="sidebar">
        <button type="button" aria-label="展开侧边栏" onClick={toggleCollapsed}>
          ‹
        </button>
      </aside>
    )
  }

  return (
    <aside className="sidebar" data-testid="sidebar" style={{ width }}>
      <header className="sidebar__header">
        <div className="sidebar__title">《{book.title}》</div>
        <button type="button" aria-label="收起侧边栏" onClick={toggleCollapsed}>›</button>
      </header>
      <button
        type="button"
        className="sidebar__all"
        data-testid="all-conversations"
        onClick={() => setShowAll(true)}
      >
        全书对话 {conversations.length} 条 ▸
      </button>
      <HistoryList
        conversations={chapterConversations}
        activeId={conversationId}
        onSelect={selectConversation}
      />
      <div className="sidebar__current">
        <div className="sidebar__current-label">
          ● {visible
            ? `第 ${visible.page}${spread ? `(+${visible.page + 1})` : ''} 页(当前)`
            : '正在加载…'}
        </div>
        {error && <div className="chat-error" data-testid="sidebar-error">{error}</div>}
        {visible && engine && (
          <MergeButton
            disabled={spread || (visible.totalPages > 0 && visible.page >= visible.totalPages)}
            onClick={() => void mergeNextPage()}
          />
        )}
        <ConversationView
          chat={chat}
          quotes={quotes}
          onRemoveQuote={(cfiRange) => selection?.toggle(cfiRange, quotes.find((q) => q.cfiRange === cfiRange)?.text ?? '')}
          onNewConversation={newConversation}
        />
      </div>
      {showAll && (
        <div className="modal-overlay" role="dialog" aria-label="全书对话">
          <div className="modal sidebar__all-dialog">
            <h2>全书对话</h2>
            {conversations.length === 0 ? <p>还没有对话</p> : conversations.map((item) => (
              <button type="button" key={item.id} className="history__entry" onClick={() => selectConversation(item.id)}>
                {item.chapterLabel ?? '未命名章节'} · 「{item.excerpt}」
              </button>
            ))}
            <div className="modal__actions">
              <button type="button" onClick={() => setShowAll(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}
