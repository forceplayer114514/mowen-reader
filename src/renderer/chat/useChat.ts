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

export function useChat(args: UseChatArgs): ChatState {
  const [messages, setMessages] = useState<MessageRecord[]>([])
  const [streaming, setStreaming] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const requestIdRef = useRef<string | null>(null)
  const accumulatedRef = useRef('')
  const conversationRef = useRef<string | null>(args.conversationId)
  const lastAttemptRef = useRef<{ text: string; quotes: QuoteRecord[] } | null>(null)
  const disposedRef = useRef(false)

  useEffect(() => {
    conversationRef.current = args.conversationId
  }, [args.conversationId])

  const commitAssistant = useCallback(async () => {
    const text = accumulatedRef.current
    accumulatedRef.current = ''
    requestIdRef.current = null
    setStreaming(null)
    const conversationId = conversationRef.current
    if (!conversationId || text.length === 0) return
    const saved = await window.api.appendMessage({
      conversationId,
      role: 'assistant',
      content: text,
      quotes: []
    })
    if (!disposedRef.current) setMessages((old) => [...old, saved])
  }, [])

  useEffect(() => {
    const offChunk = window.api.onChatChunk((requestId, text) => {
      if (requestId !== requestIdRef.current) return
      accumulatedRef.current += text
      setStreaming(accumulatedRef.current)
    })
    const offDone = window.api.onChatDone((requestId, result) => {
      if (requestId !== requestIdRef.current) return
      if (result.status === 'error') setError(result.message)
      void commitAssistant()
    })
    return () => {
      offChunk()
      offDone()
    }
  }, [commitAssistant])

  useEffect(() => {
    disposedRef.current = false
    return () => {
      disposedRef.current = true
      const id = requestIdRef.current
      if (id) void window.api.abortChat(id)
    }
  }, [])

  const run = useCallback(
    async (text: string, quotes: QuoteRecord[]) => {
      const visible = args.visible
      if (!visible) {
        setError('页面还没准备好,稍等一下再问')
        return
      }
      setError(null)
      lastAttemptRef.current = { text, quotes }
      const history: ChatMessage[] = messages.map((m) => ({ role: m.role, content: m.content }))

      let assembled
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
      } catch (e) {
        setError(e instanceof Error ? e.message : '上下文拼装失败')
        return
      }

      let conversationId = conversationRef.current
      if (!conversationId) {
        const created = await window.api.createConversation({
          bookId: args.book.id,
          startCfi: visible.startCfi,
          endCfi: visible.endCfi,
          chapterLabel: visible.chapterLabel,
          excerpt: visible.text.slice(0, 20)
        })
        conversationId = created.id
        conversationRef.current = created.id
        args.onConversationCreated(created.id)
      }

      const savedUser = await window.api.appendMessage({
        conversationId,
        role: 'user',
        content: text,
        quotes
      })
      if (!disposedRef.current) setMessages((old) => [...old, savedUser])
      args.clearQuotes()
      accumulatedRef.current = ''
      setStreaming('')
      try {
        requestIdRef.current = await window.api.startChat({ messages: assembled.messages })
      } catch (e) {
        requestIdRef.current = null
        setStreaming(null)
        setError(e instanceof Error ? e.message : '请求发不出去')
      }
    },
    [args, messages]
  )

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (trimmed.length > 0) await run(trimmed, args.getQuotes())
    },
    [args, run]
  )

  const retry = useCallback(async () => {
    const last = lastAttemptRef.current
    if (!last || !args.visible || !conversationRef.current) return
    setError(null)
    const history: ChatMessage[] = messages
      .slice(0, -1)
      .map((m) => ({ role: m.role, content: m.content }))
    try {
      const assembled = buildContext({
        systemPrompt: args.systemPrompt,
        bookTitle: args.book.title,
        author: args.book.author,
        visible: args.visible,
        toc: args.toc,
        quotes: last.quotes,
        history,
        userText: last.text,
        limit: args.contextLimit
      })
      accumulatedRef.current = ''
      setStreaming('')
      requestIdRef.current = await window.api.startChat({ messages: assembled.messages })
    } catch (e) {
      requestIdRef.current = null
      setStreaming(null)
      setError(e instanceof Error ? e.message : '重试失败')
    }
  }, [args, messages])

  const stop = useCallback(() => {
    const id = requestIdRef.current
    if (id) void window.api.abortChat(id)
  }, [])

  return { messages, streaming, error, send, stop, retry, setMessages }
}
