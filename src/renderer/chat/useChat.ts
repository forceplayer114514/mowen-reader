import { useCallback, useEffect, useRef, useState } from 'react'
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
  onConversationCreated: (id: string) => void
  getQuotes: () => QuoteRecord[]
  clearQuotes: () => void
}

export interface ChatState {
  messages: MessageRecord[]
  streaming: string | null
  error: string | null
  send: (text: string) => Promise<void>
  stop: () => void
  retry: () => Promise<void>
  setMessages: (m: MessageRecord[]) => void
}

interface RequestState {
  id: string
  conversationId: string
  accumulated: string
  current: boolean
}

interface PendingStart {
  conversationId: string
  current: boolean
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
  const lastAttemptRef = useRef<{ text: string; quotes: QuoteRecord[] } | null>(null)
  const disposedRef = useRef(false)
  const busyRef = useRef(false)
  const pendingRef = useRef<PendingStart | null>(null)
  const currentRef = useRef<RequestState | null>(null)
  const requestsRef = useRef(new Map<string, RequestState>())
  const pageKeyRef = useRef('')
  const generationRef = useRef(0)

  const release = useCallback(() => {
    busyRef.current = false
    pendingRef.current = null
  }, [])

  const abortRequest = useCallback((requestId: string) => {
    void window.api.abortChat(requestId).catch(() => {
      if (!disposedRef.current) setError('停止请求失败，请稍后重试')
    })
  }, [])

  const cancelActive = useCallback(() => {
    generationRef.current += 1
    const pending = pendingRef.current
    if (pending) pending.current = false
    const current = currentRef.current
    if (current) {
      current.current = false
      abortRequest(current.id)
      currentRef.current = null
      setStreaming(null)
    }
    release()
  }, [abortRequest, release])

  useEffect(() => {
    if (args.conversationId === conversationRef.current) return
    cancelActive()
    conversationRef.current = args.conversationId
  }, [args.conversationId, cancelActive])

  useEffect(() => {
    const key = args.visible ? `${args.visible.startCfi}|${args.visible.endCfi}` : ''
    if (pageKeyRef.current && pageKeyRef.current !== key) cancelActive()
    pageKeyRef.current = key
  }, [args.visible?.startCfi, args.visible?.endCfi, cancelActive])

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
      if (request.current) setStreaming(request.accumulated)
    })
    const offDone = window.api.onChatDone((requestId, result) => {
      const request = requestsRef.current.get(requestId)
      if (!request) return
      requestsRef.current.delete(requestId)
      const wasCurrent = request.current
      if (request.current) {
        if (result.status === 'error') setError(result.message)
        currentRef.current = null
        setStreaming(null)
      }
      void commitAssistant(request).finally(() => {
        if (wasCurrent) release()
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
        abortRequest(request.id)
      }
      currentRef.current = null
      release()
    }
  }, [abortRequest, release])

  const start = useCallback(async (messagesToSend: ChatMessage[], conversationId: string): Promise<void> => {
    const pending: PendingStart = { conversationId, current: true }
    pendingRef.current = pending
    try {
      const requestId = await window.api.startChat({ messages: messagesToSend })
      const request: RequestState = {
        id: requestId,
        conversationId,
        accumulated: '',
        current: pending.current && !disposedRef.current
      }
      requestsRef.current.set(requestId, request)
      if (!request.current) {
        abortRequest(requestId)
        release()
        return
      }
      currentRef.current = request
      setStreaming('')
    } catch (error) {
      release()
      setStreaming(null)
      if (!disposedRef.current) setError(chatError(error, '请求发不出去，请检查设置'))
    }
  }, [abortRequest, release])

  const run = useCallback(async (text: string, quotes: QuoteRecord[]): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    const generation = generationRef.current
    setStreaming('')
    const visible = args.visible
    if (!visible) {
      release()
      setStreaming(null)
      setError('页面还没准备好，请稍等一下再问')
      return
    }
    setError(null)
    lastAttemptRef.current = { text, quotes }
    const history: ChatMessage[] = messages.map((m) => ({ role: m.role, content: m.content }))
    let assembled: ReturnType<typeof buildContext>
    try {
      assembled = buildContext({
        systemPrompt: args.systemPrompt,
        bookTitle: args.book.title,
        author: args.book.author,
        visible,
        toc: args.toc,
        quotes,
        history,
        userText: text,
        limit: args.contextLimit
      })
    } catch (error) {
      release()
      setError(chatError(error, '上下文拼装失败，请稍后重试'))
      return
    }

    let conversationId = conversationRef.current
    try {
      if (!conversationId) {
        const created = await window.api.createConversation({
          bookId: args.book.id,
          startCfi: visible.startCfi,
          endCfi: visible.endCfi,
          chapterLabel: visible.chapterLabel,
          excerpt: visible.text.slice(0, 20)
        })
        if (generation !== generationRef.current || disposedRef.current) {
          release()
          return
        }
        conversationId = created.id
        conversationRef.current = created.id
      }
      if (generation !== generationRef.current || disposedRef.current) {
        release()
        return
      }
      const savedUser = await window.api.appendMessage({
        conversationId,
        role: 'user',
        content: text,
        quotes
      })
      if (generation !== generationRef.current || disposedRef.current) {
        release()
        return
      }
      setMessages((old) => [...old, savedUser])
      if (!args.conversationId && conversationId) args.onConversationCreated(conversationId)
      args.clearQuotes()
      await start(assembled.messages, conversationId)
    } catch (error) {
      release()
      setStreaming(null)
      if (!disposedRef.current) setError(chatError(error, '聊天失败，请稍后重试'))
    }
  }, [args, messages, release, start])

  const send = useCallback(async (text: string) => {
    const trimmed = text.trim()
    if (trimmed.length > 0) await run(trimmed, args.getQuotes())
  }, [args, run])

  const retry = useCallback(async () => {
    if (busyRef.current) return
    const last = lastAttemptRef.current
    const visible = args.visible
    const conversationId = conversationRef.current
    if (!last || !visible || !conversationId) return
    busyRef.current = true
    const generation = generationRef.current
    setError(null)
    setStreaming('')
    const history: ChatMessage[] = messages.slice(0, -1).map((m) => ({ role: m.role, content: m.content }))
    try {
      const assembled = buildContext({
        systemPrompt: args.systemPrompt,
        bookTitle: args.book.title,
        author: args.book.author,
        visible,
        toc: args.toc,
        quotes: last.quotes,
        history,
        userText: last.text,
        limit: args.contextLimit
      })
      if (generation !== generationRef.current || disposedRef.current) {
        release()
        return
      }
      await start(assembled.messages, conversationId)
    } catch (error) {
      release()
      setStreaming(null)
      if (!disposedRef.current) setError(chatError(error, '重试失败，请稍后重试'))
    }
  }, [args, messages, release, start])

  const stop = useCallback(() => {
    const current = currentRef.current
    if (current) abortRequest(current.id)
  }, [abortRequest])

  return { messages, streaming, error, send, stop, retry, setMessages }
}
