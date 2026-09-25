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
import ConfirmDialog from '../ConfirmDialog'

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
  const [error, setError] = useState<string | null>(null)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const conversationsRequestRef = useRef(0)
  const conversationChosenRef = useRef(false)
  const mergeInProgressRef = useRef(false)

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

  const nearbyConversations = useMemo(() => {
    if (!visible) return []
    try {
      const range = spread ? (mergedVisible ?? visible) : visible
      return conversationsOnPage(conversations, range.startCfi, range.endCfi)
    } catch {
      return []
    }
  }, [conversations, mergedVisible, spread, visible])

  const chapterConversations = useMemo(() => {
    if (!visible) return []
    try {
      const chapter = cfiChapterKey(visible.startCfi)
      return conversations.filter((conversation) => cfiChapterKey(conversation.startCfi) === chapter)
    } catch {
      return []
    }
  }, [conversations, visible])

  useEffect(() => {
    setConversationId((current) => {
      if (current && conversations.some((conversation) => conversation.id === current)) return current
      if (conversationChosenRef.current) return null
      const nearby = nearbyConversations.at(-1)
      if (nearby) conversationChosenRef.current = true
      return nearby?.id ?? null
    })
  }, [conversations, nearbyConversations])

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
      conversationChosenRef.current = true
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
    conversationChosenRef.current = true
    setConversationId(id)
    chat.setMessages([])
  }

  async function deleteConversation(id: string): Promise<void> {
    setDeleting(true)
    setError(null)
    if (id === conversationId) chat.stop()
    try {
      await window.api.deleteConversations([id])
      if (id === conversationId) {
        conversationChosenRef.current = true
        setConversationId(null)
        chat.setMessages([])
        selection?.clear()
      }
      await loadConversations()
      setPendingDeleteId(null)
    } catch {
      setPendingDeleteId(null)
      setError('对话删除失败，请稍后重试')
    } finally {
      setDeleting(false)
    }
  }

  function newConversation(): void {
    if (chat.messages.length === 0) return
    setError(null)
    chat.stop()
    conversationChosenRef.current = true
    setConversationId(null)
    chat.setMessages([])
    selection?.clear()
  }

  async function mergeNextPage(): Promise<void> {
    if (!engine || spread || mergeInProgressRef.current) return
    if (!visible) return
    mergeInProgressRef.current = true
    setConversationEndCfi(visible.endCfi)
    try {
      if (onSetSpread) await onSetSpread(true)
      else await engine.setSpread(true)
      const merged = await engine.getVisible()
      setMergedEndCfi(merged.endCfi)
      setMergedVisible(merged)
      if (conversationId) {
        await window.api.setConversationMerge(conversationId, merged.endCfi)
        await loadConversations()
      }
    } catch {
      setError('加入下一屏失败，请稍后重试')
      setMergedEndCfi(null)
      setMergedVisible(null)
      setConversationEndCfi(null)
      try {
        if (onSetSpread) await onSetSpread(false)
        else await engine.setSpread(false)
      } catch { /* keep the original error */ }
    } finally {
      mergeInProgressRef.current = false
    }
  }

  async function cancelMerge(): Promise<void> {
    if (!engine || !visible || !spread || mergeInProgressRef.current) return
    mergeInProgressRef.current = true
    setError(null)
    try {
      if (onSetSpread) await onSetSpread(false)
      else await engine.setSpread(false)
      await engine.getVisible().catch(() => visible)
      setConversationEndCfi(null)
      setMergedEndCfi(null)
      setMergedVisible(null)
      if (conversationId) {
        await window.api.setConversationMerge(conversationId, null)
        await loadConversations()
      }
    } catch {
      setError('取消扩展失败，请稍后重试')
    } finally {
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
        <button type="button" className="button--icon" aria-label="展开侧边栏" onClick={toggleCollapsed}>
          ‹
        </button>
      </aside>
    )
  }

  return (
    <>
    <aside className="sidebar" data-testid="sidebar" style={{ width }}>
      <header className="sidebar__header">
        <div>
          <span className="sidebar__eyebrow">墨问助手</span>
          <div className="sidebar__title">当前位置</div>
          <div className="sidebar__current-label" data-testid="page-conversations-summary">
            {visible
              ? `附近 ${nearbyConversations.length} · 本章 ${chapterConversations.length} 个对话`
              : '正在加载…'}
          </div>
        </div>
        <button type="button" className="button--icon" aria-label="收起侧边栏" onClick={toggleCollapsed}>›</button>
      </header>
      <HistoryList
        conversations={chapterConversations}
        activeId={conversationId}
        onSelect={selectConversation}
        onLocate={(startCfi) => void engine?.display(startCfi)}
        onDelete={setPendingDeleteId}
      />
      <div className="sidebar__current">
        {error && <div className="chat-error" data-testid="sidebar-error">{error}</div>}
        {visible && engine && (
          <MergeButton
            merged={spread}
            onClick={() => void (spread ? cancelMerge() : mergeNextPage())}
          />
        )}
        <ConversationView
          chat={chat}
          quotes={quotes}
          onRemoveQuote={(cfiRange) => selection?.toggle(cfiRange, quotes.find((q) => q.cfiRange === cfiRange)?.text ?? '')}
          onTranslateQuote={(quote) => void chat.translate([quote])}
          onNewConversation={newConversation}
        />
      </div>
    </aside>
    {pendingDeleteId && <ConfirmDialog
      title="删除这个对话？"
      message="对话中的消息也会一并删除，删除后无法恢复。"
      confirmLabel="确认删除"
      onCancel={() => setPendingDeleteId(null)}
      onConfirm={() => void deleteConversation(pendingDeleteId)}
      busy={deleting}
      testId="confirm-history-delete"
      confirmTestId="confirm-history-delete-yes"
    />}
    </>
  )
}
