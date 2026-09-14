import { useCallback, useEffect, useMemo, useState } from 'react'
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
import { useChat } from './useChat'

interface Props {
  book: BookRecord
  engine: ReaderEngine | null
  visible: VisibleRange | null
  toc: TocItem[]
  selection: SelectionStore | null
}

const DEFAULT_PROMPT = '请用简体中文回答，不剧透后文，回答简洁。'

export function mergeLoadedMessages(loaded: MessageRecord[], local: MessageRecord[]): MessageRecord[] {
  return loaded.length === 0 && local.length > 0 ? local : loaded
}

export default function Sidebar({ book, engine: _engine, visible, toc, selection }: Props) {
  const [conversations, setConversations] = useState<ConversationWithCount[]>([])
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [quotes, setQuotes] = useState<QuoteRecord[]>([])
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_PROMPT)
  const [contextLimit, setContextLimit] = useState(8000)
  const [width, setWidth] = useState(340)
  const [collapsed, setCollapsed] = useState(false)
  const [showAll, setShowAll] = useState(false)

  const loadConversations = useCallback(async () => {
    try {
      setConversations(await window.api.listConversations(book.id))
    } catch {
      setConversations([])
    }
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
    visible,
    toc,
    systemPrompt,
    contextLimit,
    conversationId,
    onConversationCreated: (id) => {
      setConversationId(id)
      void loadConversations()
    },
    getQuotes: () => selection?.list() ?? quotes,
    clearQuotes: () => selection?.clear()
  })

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
      if (!cancelled) chat.setMessages((local) => mergeLoadedMessages(messages, local))
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
    if (chat.messages.length > 0) {
      const keep = window.confirm('保留本页当前对话?')
      if (!keep) {
        if (conversationId) {
          void window.api.deleteConversations([conversationId]).then(loadConversations).catch(() => {})
        }
      }
    }
    setConversationId(null)
    chat.setMessages([])
    selection?.clear()
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
          ● {visible ? `第 ${visible.page} 页(当前)` : '正在加载…'}
        </div>
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
