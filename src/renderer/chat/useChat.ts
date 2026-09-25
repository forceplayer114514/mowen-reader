import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react'
import type { BookRecord, MessageRecord, QuoteRecord } from '@shared/types'
import type { TocItem, VisibleRange } from '../reader/types'
import { buildContext, type ChatMessage } from './context'

export interface UseChatArgs {
  book: BookRecord
  visible: VisibleRange | null
  toc: TocItem[]
  systemPrompt: string
  contextLimit: number
  conversationId: string | null
  conversationEndCfi?: string | null
  mergedEndCfi?: string | null
  onConversationCreated: (id: string, mergedEndCfi?: string | null) => void | Promise<void>
  getQuotes: () => QuoteRecord[]
  clearQuotes: () => void
}

export interface ChatState {
  messages: MessageRecord[]
  streaming: string | null
  error: string | null
  send: (text: string) => Promise<void>
  translate: (quotes: QuoteRecord[]) => Promise<void>
  stop: () => void
  retry: () => Promise<void>
  setMessages: (m: SetStateAction<MessageRecord[]>) => void
}

interface Attempt {
  text: string
  quotes: QuoteRecord[]
  messages?: ChatMessage[]
}

interface Owner {
  token: symbol
  canceled: boolean
  reportCleanupError: boolean
  createdConversationId: string | null
  userMessagePending: boolean
  userMessageSaved: boolean
}

interface RequestState {
  id: string
  conversationId: string
  accumulated: string
  current: boolean
  owner: Owner
}

interface PendingStart {
  conversationId: string
  current: boolean
  owner: Owner
}

function chatError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : ''
  return /[\u3400-\u9fff]/.test(message) ? message : fallback
}

export function useChat(args: UseChatArgs): ChatState {
  const [messages, setMessages] = useState<MessageRecord[]>([])
  const [streaming, setStreaming] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const conversationRef = useRef<string | null>(args.conversationId)
  const lastAttemptRef = useRef<Attempt | null>(null)
  const disposedRef = useRef(false)
  const busyRef = useRef(false)
  const ownerRef = useRef<Owner | null>(null)
  const pendingRef = useRef<PendingStart | null>(null)
  const currentRef = useRef<RequestState | null>(null)
  const requestsRef = useRef(new Map<string, RequestState>())
  const generationRef = useRef(0)

  const isOwner = useCallback((owner: Owner) => ownerRef.current === owner, [])

  const release = useCallback((owner: Owner) => {
    if (!isOwner(owner)) return
    busyRef.current = false
    if (pendingRef.current?.owner === owner) pendingRef.current = null
    ownerRef.current = null
  }, [isOwner])

  const abortRequest = useCallback((requestId: string, owner?: Owner) => {
    void window.api.abortChat(requestId).catch(() => {
      if (!disposedRef.current && (!owner || isOwner(owner))) setError('停止请求失败，请稍后重试')
    })
  }, [isOwner])

  const cleanupCreatedConversation = useCallback((owner: Owner, reportError = false) => {
    if (reportError) owner.reportCleanupError = true
    if (
      !owner.createdConversationId ||
      owner.userMessagePending ||
      owner.userMessageSaved
    ) return
    const id = owner.createdConversationId
    owner.createdConversationId = null
    void window.api.deleteConversations([id]).catch(() => {
      if (!disposedRef.current && (owner.reportCleanupError || isOwner(owner))) {
        setError('空对话删除失败，可能仍会保留，请稍后手动删除')
      }
    })
  }, [isOwner])

  const cancelActive = useCallback((preservePartial = false) => {
    generationRef.current += 1
    const owner = ownerRef.current
    if (!owner) {
      for (const request of requestsRef.current.values()) {
        if (!request.current) continue
        request.current = false
        abortRequest(request.id, request.owner)
      }
      return
    }
    owner.canceled = true
    const pending = pendingRef.current
    if (pending?.owner === owner) pending.current = false
    const current = currentRef.current
    if (current?.owner === owner) {
      if (!preservePartial) current.current = false
      abortRequest(current.id, owner)
      currentRef.current = null
    }
    cleanupCreatedConversation(owner, preservePartial)
    setStreaming(null)
    setError(null)
    release(owner)
  }, [abortRequest, cleanupCreatedConversation, release])

  useEffect(() => {
    if (args.conversationId === conversationRef.current) return
    cancelActive()
    lastAttemptRef.current = null
    setError(null)
    conversationRef.current = args.conversationId
  }, [args.conversationId, cancelActive])

  const commitAssistant = useCallback(async (request: RequestState): Promise<void> => {
    const text = request.accumulated
    request.accumulated = ''
    if (text.length === 0) return
    try {
      const saved = await window.api.appendMessage({
        conversationId: request.conversationId,
        role: 'assistant',
        content: text,
        quotes: []
      })
      if (
        request.current &&
        conversationRef.current === request.conversationId &&
        !disposedRef.current
      ) {
        setMessages((old) => [...old, saved])
      }
    } catch (error) {
      if (request.current && !disposedRef.current) {
        setError(chatError(error, '回答保存失败，请稍后重试'))
      }
    }
  }, [])

  useEffect(() => {
    const offChunk = window.api.onChatChunk((requestId, text) => {
      const request = requestsRef.current.get(requestId)
      if (!request) return
      request.accumulated += text
      if (request.current && !request.owner.canceled) setStreaming(request.accumulated)
    })
    const offDone = window.api.onChatDone((requestId, result) => {
      const request = requestsRef.current.get(requestId)
      if (!request) return
      requestsRef.current.delete(requestId)
      const wasCurrent = request.current
      if (request.current) {
        if (result.status === 'error' && !request.owner.canceled) setError(result.message)
        currentRef.current = null
        setStreaming(null)
      }
      void commitAssistant(request).finally(() => {
        if (wasCurrent) release(request.owner)
      })
    })
    return () => {
      offChunk()
      offDone()
    }
  }, [commitAssistant, release])

  useEffect(() => {
    disposedRef.current = false
    return () => {
      disposedRef.current = true
      const pending = pendingRef.current
      if (pending) pending.current = false
      for (const request of requestsRef.current.values()) {
        request.current = false
        abortRequest(request.id, request.owner)
      }
      currentRef.current = null
      const owner = ownerRef.current
      if (owner) release(owner)
    }
  }, [abortRequest, release])

  const start = useCallback(async (messagesToSend: ChatMessage[], conversationId: string, owner: Owner): Promise<void> => {
    const pending: PendingStart = { conversationId, current: true, owner }
    pendingRef.current = pending
    try {
      const requestId = await window.api.startChat({ messages: messagesToSend })
      const request: RequestState = {
        id: requestId,
        conversationId,
        accumulated: '',
        current: pending.current && !pending.owner.canceled && isOwner(pending.owner) && !disposedRef.current,
        owner: pending.owner
      }
      requestsRef.current.set(requestId, request)
      if (!request.current) {
        abortRequest(requestId, pending.owner)
        release(pending.owner)
        return
      }
      currentRef.current = request
      setStreaming('')
    } catch (error) {
      const current = isOwner(pending.owner)
      release(pending.owner)
      if (current) {
        setStreaming(null)
        if (!disposedRef.current) setError(chatError(error, '请求发不出去，请检查设置'))
      }
    }
  }, [abortRequest, isOwner, release])

  const run = useCallback(async (text: string, quotes: QuoteRecord[], requestMessages?: ChatMessage[]): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    const owner: Owner = {
      token: Symbol('chat-run'),
      canceled: false,
      reportCleanupError: false,
      createdConversationId: null,
      userMessagePending: false,
      userMessageSaved: false
    }
    ownerRef.current = owner
    const generation = generationRef.current
    setStreaming('')
    const visible = args.visible
    if (!visible) {
      release(owner)
      setStreaming(null)
      setError('页面还没准备好，请稍等一下再问')
      return
    }
    setError(null)
    lastAttemptRef.current = { text, quotes, messages: requestMessages }
    let messagesToSend: ChatMessage[]
    try {
      messagesToSend = requestMessages ?? buildContext({
        systemPrompt: args.systemPrompt,
        bookTitle: args.book.title,
        author: args.book.author,
        visible,
        toc: args.toc,
        quotes,
        history: messages.map(toHistoryMessage),
        userText: text,
        limit: args.contextLimit
      }).messages
    } catch (error) {
      const current = isOwner(owner)
      release(owner)
      if (current) setError(chatError(error, '上下文拼装失败，请稍后重试'))
      return
    }

    let conversationId = conversationRef.current
    let createdConversationId: string | null = null
    let userMessageSaved = false
    try {
      if (!conversationId) {
        const created = await window.api.createConversation({
          bookId: args.book.id,
          startCfi: quotes.find((quote) => quote.startCfi)?.startCfi ?? visible.startCfi,
          endCfi: args.conversationEndCfi ?? visible.endCfi,
          chapterLabel: visible.chapterLabel,
          excerpt: visible.text.slice(0, 20)
        })
        createdConversationId = created.id
        owner.createdConversationId = created.id
        if (generation !== generationRef.current || disposedRef.current) {
          cleanupCreatedConversation(owner)
          release(owner)
          return
        }
        conversationId = created.id
      }
      if (generation !== generationRef.current || disposedRef.current) {
        cleanupCreatedConversation(owner)
        release(owner)
        return
      }
      owner.userMessagePending = true
      const savedUser = await window.api.appendMessage({
        conversationId,
        role: 'user',
        content: text,
        quotes
      })
      owner.userMessagePending = false
      owner.userMessageSaved = true
      userMessageSaved = true
      if (generation !== generationRef.current || disposedRef.current) {
        cleanupCreatedConversation(owner)
        release(owner)
        return
      }
      conversationRef.current = conversationId
      setMessages((old) => [...old, savedUser])
      if (!args.conversationId && conversationId) {
        await args.onConversationCreated(conversationId, args.mergedEndCfi)
      }
      args.clearQuotes()
      await start(messagesToSend, conversationId, owner)
    } catch (error) {
      const current = isOwner(owner)
      owner.userMessagePending = false
      if (createdConversationId && !userMessageSaved) cleanupCreatedConversation(owner, current)
      release(owner)
      if (current) {
        setStreaming(null)
        if (!disposedRef.current) setError(chatError(error, '聊天失败，请稍后重试'))
      }
    }
  }, [args, cleanupCreatedConversation, isOwner, messages, release, start])

  const send = useCallback(async (text: string) => {
    const trimmed = text.trim()
    if (trimmed.length > 0) await run(trimmed, args.getQuotes())
  }, [args, run])

  const translate = useCallback(async (quotes: QuoteRecord[]) => {
    if (quotes.length === 0) return
    const selected = quotes.map((quote) => quote.text).join('\n')
    await run('翻译', quotes, [{ role: 'user', content: `翻译：\n${selected}` }])
  }, [run])

  const retry = useCallback(async () => {
    if (busyRef.current) return
    const last = lastAttemptRef.current
    const visible = args.visible
    const conversationId = conversationRef.current
    if (!last || !visible || !conversationId) return
    busyRef.current = true
    const owner: Owner = {
      token: Symbol('chat-retry'),
      canceled: false,
      reportCleanupError: false,
      createdConversationId: null,
      userMessagePending: false,
      userMessageSaved: true
    }
    ownerRef.current = owner
    const generation = generationRef.current
    setError(null)
    setStreaming('')
    const history: ChatMessage[] = messages.slice(0, -1).map(toHistoryMessage)
    try {
      const messagesToSend = last.messages ?? buildContext({
        systemPrompt: args.systemPrompt,
        bookTitle: args.book.title,
        author: args.book.author,
        visible,
        toc: args.toc,
        quotes: last.quotes,
        history,
        userText: last.text,
        limit: args.contextLimit
      }).messages
      if (generation !== generationRef.current || disposedRef.current) {
        release(owner)
        return
      }
      await start(messagesToSend, conversationId, owner)
    } catch (error) {
      const current = isOwner(owner)
      release(owner)
      if (current) {
        setStreaming(null)
        if (!disposedRef.current) setError(chatError(error, '重试失败，请稍后重试'))
      }
    }
  }, [args, isOwner, messages, release, start])

  const stop = useCallback(() => {
    cancelActive(true)
  }, [cancelActive])

  return { messages, streaming, error, send, translate, stop, retry, setMessages }
}

function toHistoryMessage(message: MessageRecord): ChatMessage {
  if (message.role !== 'user' || message.quotes.length === 0) {
    return { role: message.role, content: message.content }
  }
  return {
    role: 'user',
    content: `用户划选的原文:\n${message.quotes.map((quote) => `> ${quote.text}`).join('\n')}\n\n${message.content}`
  }
}
