import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  BookRecord,
  AnnotationRecord,
  ConversationWithCount,
  MessageRecord,
  QuoteRecord
} from '@shared/types'
import type { VocabRecord } from '@shared/vocab-types'
import { conversationsOnPage } from '../reader/anchor'
import { cfiChapterKey, compareCfi } from '../reader/cfi'
import type { ReaderEngine, TocItem, VisibleRange } from '../reader/types'
import type { SelectionStore } from '../reader/selection'
import ConversationView from './ConversationView'
import HistoryList from './HistoryList'
import MergeButton from './MergeButton'
import { useChat } from './useChat'
import { DEFAULT_CONTEXT_LIMIT, DEFAULT_SYSTEM_PROMPT } from '../settings/defaults'
import ConfirmDialog from '../ConfirmDialog'
import AnnotationView, { AnnotationComposer, type AnnotationDraft } from './AnnotationView'
import VocabView from './VocabView'

interface Props {
  book: BookRecord
  engine: ReaderEngine | null
  visible: VisibleRange | null
  toc: TocItem[]
  selection: SelectionStore | null
  restoring?: boolean
  spread?: boolean
  onSetSpread?: (on: boolean) => Promise<void>
  onNavigate?: () => void
  onAnnotationState?: (dirty: boolean, saving: boolean) => void
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
  const localById = new Map(localForConversation.map((message) => [message.id, message]))
  return [
    ...loaded.map((message) => {
      const newer = localById.get(message.id)
      // 回答仅追加：较早的流式读取快照不能覆盖刚收到的完整回答。
      return newer?.role === 'assistant' && newer.content.length > message.content.length ? newer : message
    }),
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
  onSetSpread,
  onNavigate,
  onAnnotationState
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
  const [pendingTranslation, setPendingTranslation] = useState<QuoteRecord | null>(null)
  const [translationConsentBusy, setTranslationConsentBusy] = useState(false)
  const translationConsentChecking = useRef(false)
  const [deleting, setDeleting] = useState(false)
  const conversationsRequestRef = useRef(0)
  const conversationChosenRef = useRef(false)
  const mergeInProgressRef = useRef(false)
  const [tab, setTab] = useState<'chat' | 'annotations' | 'vocab'>('chat')
  const [annotations, setAnnotations] = useState<AnnotationRecord[]>([])
  const [annotationDraft, setAnnotationDraft] = useState<AnnotationDraft | null>(null)
  const [annotationError, setAnnotationError] = useState<string | null>(null)
  const [notesReady, setNotesReady] = useState(false)
  const [noteBusy, setNoteBusy] = useState(false)
  const [pendingNoteAction, setPendingNoteAction] = useState<{ run: () => void } | null>(null)
  const [pendingDeleteNote, setPendingDeleteNote] = useState<AnnotationRecord | null>(null)
  const [vocabs, setVocabs] = useState<VocabRecord[]>([])
  const [vocabError, setVocabError] = useState<string | null>(null)
  const [vocabBusy, setVocabBusy] = useState(false)
  const [pendingDeleteVocab, setPendingDeleteVocab] = useState<VocabRecord | null>(null)
  const vocabBusyRef = useRef(false)
  const noteBusyRef = useRef(false)
  const notesAliveRef = useRef(false)
  const openNoteRef = useRef<(note: AnnotationRecord) => void>(() => {})

  const sortedNotes = useMemo(() => [...annotations].sort((a, b) => {
    try { return compareCfi(a.startCfi, b.startCfi) || a.createdAt - b.createdAt || a.id.localeCompare(b.id) }
    catch { return a.createdAt - b.createdAt }
  }), [annotations])

  const vocabCfiRanges = useMemo(() => new Set(vocabs.map((item) => item.cfiRange)), [vocabs])

  useEffect(() => {
    let cancelled = false
    void window.api.listVocab(book.id).then((items) => {
      if (!cancelled) { setVocabs(items); setVocabError((old) => old === '生词读取失败，请重新打开图书后重试' ? null : old) }
    }).catch(() => {
      if (!cancelled) setVocabError('生词读取失败，请重新打开图书后重试')
    })
    return () => { cancelled = true }
  }, [book.id])

  useEffect(() => {
    let cancelled = false
    notesAliveRef.current = true
    void window.api.listAnnotations(book.id).then((items) => {
      if (!cancelled) { setAnnotations(items); setNotesReady(true) }
    }).catch(() => {
      if (!cancelled) setAnnotationError('注释读取失败，请重新打开图书后重试')
    })
    return () => { cancelled = true; notesAliveRef.current = false }
  }, [book.id])

  useEffect(() => {
    engine?.setAnnotations(sortedNotes.map((note, index) => ({ id: note.id, cfiRange: note.cfiRange, number: index + 1 })), (id) => {
      const note = sortedNotes.find((item) => item.id === id)
      if (note) openNoteRef.current(note)
    })
  }, [engine, sortedNotes])
  useEffect(() => () => { engine?.setAnnotations([], () => {}) }, [engine])

  function draftChanged(): boolean {
    if (!annotationDraft) return false
    const original = annotations.find((item) => item.id === annotationDraft.id)?.content ?? ''
    return annotationDraft.content.trim() !== original.trim()
  }

  const noteDirty = draftChanged()
  useEffect(() => { onAnnotationState?.(noteDirty, noteBusy) }, [onAnnotationState, noteDirty, noteBusy])

  function changeNote(run: () => void): void {
    if (noteBusyRef.current) return
    if (draftChanged()) setPendingNoteAction({ run })
    else run()
  }

  function editNote(note: AnnotationRecord, reveal = false): void {
    setCollapsed(false)
    if (reveal) setTab('annotations')
    if (noteBusyRef.current) { setAnnotationError('注释正在保存，请稍候'); return }
    if (annotationDraft?.id === note.id) return
    changeNote(() => {
      setAnnotationError(null)
      setAnnotationDraft({ id: note.id, quote: { cfiRange: note.cfiRange, text: note.quote, startCfi: note.startCfi },
        chapterLabel: note.chapterLabel, content: note.content })
    })
  }
  openNoteRef.current = (note) => editNote(note, true)

  function annotateQuote(quote: QuoteRecord): void {
    if (!notesReady || noteBusyRef.current) return
    const existing = annotations.find((item) => item.cfiRange === quote.cfiRange)
    if (existing) { editNote(existing); return }
    if (annotationDraft?.quote.cfiRange === quote.cfiRange) return
    changeNote(() => {
      if (!quote.startCfi) { setAnnotationError('原文位置不可用，请重新划选这段文字'); return }
      let chapterLabel: string | null = null
      try {
        if (visible && cfiChapterKey(quote.startCfi) === cfiChapterKey(visible.startCfi)) chapterLabel = visible.chapterLabel
      } catch { /* 没有可靠章节信息时不猜章节名。 */ }
      setAnnotationError(null)
      setAnnotationDraft({ id: null, quote: { ...quote }, chapterLabel, content: '' })
    })
  }

  function cancelAnnotation(): void {
    if (noteBusyRef.current) return
    setAnnotationDraft(null)
    setAnnotationError(null)
  }

  async function submitAnnotation(): Promise<void> {
    const draft = annotationDraft
    if (!draft?.content.trim() || !draft.quote.startCfi || !notesReady || noteBusyRef.current) return
    noteBusyRef.current = true
    setNoteBusy(true)
    setAnnotationError(null)
    try {
      const saved = draft.id
        ? await window.api.updateAnnotation(draft.id, draft.content)
        : await window.api.createAnnotation({ bookId: book.id, startCfi: draft.quote.startCfi,
          cfiRange: draft.quote.cfiRange, quote: draft.quote.text, chapterLabel: draft.chapterLabel, content: draft.content })
      if (!notesAliveRef.current) return
      setAnnotations((items) => [...items.filter((item) => item.id !== saved.id), saved])
      setAnnotationDraft(null)
      if (selection?.list().some((quote) => quote.cfiRange === draft.quote.cfiRange)) {
        selection.toggle(draft.quote.cfiRange, draft.quote.text)
      }
    } catch {
      if (notesAliveRef.current) setAnnotationError('注释保存失败，内容已保留，请再次提交')
    } finally {
      noteBusyRef.current = false
      if (notesAliveRef.current) setNoteBusy(false)
    }
  }

  async function removeAnnotation(note: AnnotationRecord): Promise<void> {
    if (noteBusyRef.current) return
    noteBusyRef.current = true
    setNoteBusy(true)
    try {
      await window.api.deleteAnnotation(note.id)
      if (!notesAliveRef.current) return
      setAnnotations((items) => items.filter((item) => item.id !== note.id))
      if (annotationDraft?.id === note.id) setAnnotationDraft(null)
      setAnnotationError(null)
      setPendingDeleteNote(null)
    } catch {
      if (notesAliveRef.current) { setPendingDeleteNote(null); setAnnotationError('注释删除失败，请稍后重试') }
    } finally {
      noteBusyRef.current = false
      if (notesAliveRef.current) setNoteBusy(false)
    }
  }

  // 生词收藏：只用已落盘的翻译结果与划选 quote 元数据，不再发起任何 AI/翻译请求。
  async function saveVocab(sources: QuoteRecord[], translation: string): Promise<void> {
    const first = sources.find((quote) => quote.startCfi)
    if (!first?.startCfi || vocabBusyRef.current) return
    vocabBusyRef.current = true
    setVocabBusy(true)
    setVocabError(null)
    try {
      let chapterLabel: string | null = null
      try {
        if (visible && cfiChapterKey(first.startCfi) === cfiChapterKey(visible.startCfi)) chapterLabel = visible.chapterLabel
      } catch { /* 没有可靠章节信息时不猜章节名。 */ }
      const saved = await window.api.addVocab({ bookId: book.id, startCfi: first.startCfi,
        cfiRange: first.cfiRange, sourceText: sources.map((quote) => quote.text).join('\n'),
        translation, chapterLabel })
      if (!notesAliveRef.current) return
      setVocabs((items) => [...items.filter((item) => item.id !== saved.id && item.cfiRange !== saved.cfiRange), saved])
    } catch {
      if (notesAliveRef.current) setVocabError('生词收藏失败，请稍后重试')
    } finally {
      vocabBusyRef.current = false
      if (notesAliveRef.current) setVocabBusy(false)
    }
  }

  async function removeVocab(vocab: VocabRecord): Promise<void> {
    if (vocabBusyRef.current) return
    vocabBusyRef.current = true
    setVocabBusy(true)
    try {
      await window.api.deleteVocab(vocab.id)
      if (!notesAliveRef.current) return
      setVocabs((items) => items.filter((item) => item.id !== vocab.id))
      setVocabError(null)
      setPendingDeleteVocab(null)
    } catch {
      if (notesAliveRef.current) { setPendingDeleteVocab(null); setVocabError('生词删除失败，请稍后重试') }
    } finally {
      vocabBusyRef.current = false
      if (notesAliveRef.current) setVocabBusy(false)
    }
  }

  const loadConversations = useCallback(async () => {
    const request = ++conversationsRequestRef.current
    try {
      const loaded = await window.api.listConversations(book.id)
      if (request === conversationsRequestRef.current) {
        setConversations(loaded)
        setError((old) => old === '对话列表读取失败，已保存记录未删除，请重新打开图书后重试' ? null : old)
      }
    } catch {
      if (request === conversationsRequestRef.current) setError('对话列表读取失败，已保存记录未删除，请重新打开图书后重试')
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
      if (!cancelled) {
        chat.setMessages((local) => mergeLoadedMessages(messages, local, conversationId))
        setError((old) => old === '对话读取失败，已保存记录未删除，请重新打开图书后重试' ? null : old)
      }
    }).catch(() => {
      if (!cancelled) setError('对话读取失败，已保存记录未删除，请重新打开图书后重试')
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

  const removeQuote = (cfiRange: string): void => { selection?.toggle(cfiRange, quotes.find((q) => q.cfiRange === cfiRange)?.text ?? '') }
  const translateQuote = (quote: QuoteRecord): void => {
    if (translationConsentChecking.current || chat.streaming !== null) return
    translationConsentChecking.current = true
    void Promise.all([window.api.getSetting('translation.mode'), window.api.getSetting('translation.onlineConsent')])
      .then(([mode, consent]) => {
        if (!notesAliveRef.current) return
        if (mode !== 'offline' && consent !== 'true') { setPendingTranslation(quote); return }
        setTab('chat')
        void chat.translate([quote])
      }).catch(() => { if (notesAliveRef.current) setError('翻译设置读取失败，请重试') })
      .finally(() => { translationConsentChecking.current = false })
  }

  async function approveTranslation(): Promise<void> {
    if (!pendingTranslation || translationConsentBusy) return
    const quote = pendingTranslation
    setTranslationConsentBusy(true)
    try {
      await window.api.setSetting('translation.onlineConsent', 'true')
      if (!notesAliveRef.current) return
      setPendingTranslation(null)
      setTab('chat')
      void chat.translate([quote])
    } catch { if (notesAliveRef.current) setError('授权保存失败，请重试') }
    finally { if (notesAliveRef.current) setTranslationConsentBusy(false) }
  }

  return (
    <>
    <aside className={`sidebar${collapsed ? ' sidebar--collapsed' : ''}`} data-testid="sidebar" style={{ width }}>
      {collapsed &&
        <button type="button" className="button--icon" aria-label="展开侧边栏" onClick={toggleCollapsed}>
          ‹
        </button>}
      <div className="sidebar__panels" hidden={collapsed}>
      <header className="sidebar__header">
        <div>
          <span className="sidebar__eyebrow">墨问助手</span>
          <div className="sidebar__title">{tab === 'chat' ? '当前位置' : tab === 'annotations' ? '原文注释' : '生词收藏'}</div>
          <div className="sidebar__current-label" data-testid="page-conversations-summary" hidden={tab !== 'chat'}>
            {visible
              ? `附近 ${nearbyConversations.length} · 本章 ${chapterConversations.length} 个对话`
              : '正在加载…'}
          </div>
          {tab === 'annotations' && <div className="sidebar__current-label">本地保存 · 全书 {annotations.length} 条</div>}
          {tab === 'vocab' && <div className="sidebar__current-label">本地保存 · 全书 {vocabs.length} 条</div>}
        </div>
        <button type="button" className="button--icon" aria-label="收起侧边栏" onClick={toggleCollapsed}>›</button>
      </header>
      <div className="sidebar__tabs" role="tablist" aria-label="阅读侧栏">
        <button type="button" role="tab" id="chat-tab" aria-selected={tab === 'chat'} aria-controls="chat-panel"
          data-testid="sidebar-tab-chat" onClick={() => setTab('chat')}>对话</button>
        <button type="button" role="tab" id="annotations-tab" aria-selected={tab === 'annotations'} aria-controls="annotations-panel"
          data-testid="sidebar-tab-annotations" onClick={() => setTab('annotations')}>注释 {annotations.length > 0 && <small>{annotations.length}</small>}</button>
        <button type="button" role="tab" id="vocab-tab" aria-selected={tab === 'vocab'} aria-controls="vocab-panel"
          data-testid="sidebar-tab-vocab" onClick={() => setTab('vocab')}>生词 {vocabs.length > 0 && <small>{vocabs.length}</small>}</button>
      </div>
      <div className="sidebar__panel" id="chat-panel" role="tabpanel" aria-labelledby="chat-tab" hidden={tab !== 'chat'}>
      <HistoryList
        conversations={chapterConversations}
        activeId={conversationId}
        onSelect={selectConversation}
        onLocate={(startCfi) => { onNavigate?.(); void engine?.display(startCfi) }}
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
          quotes={tab === 'chat' ? quotes : []}
          onRemoveQuote={removeQuote}
          onTranslateQuote={translateQuote}
          onAnnotateQuote={annotateQuote}
          annotationBusy={noteBusy || !notesReady}
          vocabCfiRanges={vocabCfiRanges}
          vocabBusy={vocabBusy}
          vocabError={vocabError}
          onSaveVocab={(sources, translation) => void saveVocab(sources, translation)}
          annotationEditor={tab === 'chat' && annotationDraft ? <AnnotationComposer notes={sortedNotes}
            draft={annotationDraft} active={!collapsed} busy={noteBusy || !notesReady} error={annotationError}
            onContent={(content) => setAnnotationDraft((draft) => draft ? { ...draft, content } : null)}
            onSubmit={() => void submitAnnotation()} onCancel={cancelAnnotation} /> : null}
          onNewConversation={newConversation}
        />
      </div>
      </div>
      <div className="sidebar__panel" id="annotations-panel" role="tabpanel" aria-labelledby="annotations-tab" hidden={tab !== 'annotations'}>
        <AnnotationView notes={sortedNotes} visible={visible} draft={annotationDraft}
          active={tab === 'annotations' && !collapsed} busy={noteBusy || !notesReady} error={annotationError}
          quotes={tab === 'annotations' ? quotes : []} chatBusy={chat.streaming !== null} onEdit={editNote}
          onLocate={(note) => { onNavigate?.(); void engine?.display(note.startCfi).catch(() => setAnnotationError('原文定位失败，请重开图书后重试')) }}
          onDelete={setPendingDeleteNote} onContent={(content) => setAnnotationDraft((draft) => draft ? { ...draft, content } : null)}
          onSubmit={() => void submitAnnotation()} onCancel={cancelAnnotation}
          onRemoveQuote={removeQuote} onTranslateQuote={translateQuote} onAnnotateQuote={annotateQuote} />
      </div>
      <div className="sidebar__panel" id="vocab-panel" role="tabpanel" aria-labelledby="vocab-tab" hidden={tab !== 'vocab'}>
        <VocabView vocabs={vocabs} busy={vocabBusy} error={vocabError}
          onLocate={(vocab) => { onNavigate?.(); void engine?.display(vocab.startCfi).catch(() => setVocabError('原文定位失败，请重开图书后重试')) }}
          onDelete={setPendingDeleteVocab} />
      </div>
      </div>
    </aside>
    {pendingTranslation && <ConfirmDialog title="使用免费在线翻译？" tone="neutral"
      message="只将你选中的单词发送给有道词典，或将选中的句子发送给 MyMemory；不发送书籍全文、聊天记录或 API 密钥。服务有网络与额度限制；也可在设置中选择离线。"
      confirmLabel="同意并翻译" onCancel={() => setPendingTranslation(null)}
      onConfirm={() => void approveTranslation()} busy={translationConsentBusy}
      testId="translation-consent" confirmTestId="translation-consent-yes" />}
    {pendingNoteAction && <ConfirmDialog title="放弃未提交的注释？" message="当前编辑的内容尚未保存，切换原文会丢弃这些修改。"
      confirmLabel="放弃修改" onCancel={() => setPendingNoteAction(null)}
      onConfirm={() => { pendingNoteAction.run(); setPendingNoteAction(null) }} testId="confirm-note-discard" />}
    {pendingDeleteNote && <ConfirmDialog title="删除这条注释？" message={annotationDraft?.id === pendingDeleteNote.id && noteDirty
      ? '这条注释及其未提交的修改都会删除，无法恢复。原文不会改变。'
      : '原文不会改变，注释删除后无法恢复，其余编号会按原文顺序更新。'}
      confirmLabel="删除注释" onCancel={() => setPendingDeleteNote(null)} busy={noteBusy}
      onConfirm={() => void removeAnnotation(pendingDeleteNote)} testId="confirm-note-delete" confirmTestId="confirm-note-delete-yes" />}
    {pendingDeleteVocab && <ConfirmDialog title="删除这条生词？" message={`「${pendingDeleteVocab.sourceText.slice(0, 40)}」的收藏会删除，原文不会改变，删除后无法恢复。`}
      confirmLabel="删除生词" onCancel={() => setPendingDeleteVocab(null)} busy={vocabBusy}
      onConfirm={() => void removeVocab(pendingDeleteVocab)} testId="confirm-vocab-delete" confirmTestId="confirm-vocab-delete-yes" />}
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
