// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChat, type ChatState, type UseChatArgs } from '../../src/renderer/chat/useChat'
import { mergeLoadedMessages } from '../../src/renderer/chat/Sidebar'
import type { MessageRecord } from '../../src/shared/types'
import type { VisibleRange } from '../../src/renderer/reader/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const visible: VisibleRange = {
  text: '当前页面文字',
  startCfi: 'epubcfi(/6/4!/4/2/2/1:0)',
  endCfi: 'epubcfi(/6/4!/4/2/8/1:0)',
  rangeCfi: 'epubcfi(/6/4!/4/2,/2/1:0,/8/1:0)',
  approximate: false,
  chapterHref: 'Text/ch1.xhtml',
  chapterLabel: '第一章',
  page: 1,
  totalPages: 2
}

function message(conversationId: string, role: 'user' | 'assistant', content: string): MessageRecord {
  return { id: `${role}-${content}`, conversationId, role, content, quotes: [], createdAt: Date.now() }
}

function apiHarness() {
  let chunk: ((id: string, text: string) => void) | null = null
  let done: ((id: string, result: { status: 'finished' | 'error'; message?: string }) => void) | null = null
  const abortChat = vi.fn(async () => {})
  const startChat = vi.fn(async () => 'request-1')
  const appendMessage = vi.fn(async (input: { conversationId: string; role: 'user' | 'assistant'; content: string }) =>
    message(input.conversationId, input.role, input.content))
  const api = {
    createConversation: vi.fn(async () => ({
      id: 'conversation-new', bookId: 'book', startCfi: visible.startCfi, endCfi: visible.endCfi,
      mergedEndCfi: null, chapterLabel: visible.chapterLabel, excerpt: visible.text, createdAt: Date.now()
    })),
    appendMessage,
    startChat,
    abortChat,
    onChatChunk: vi.fn((cb: typeof chunk) => { chunk = cb; return () => { chunk = null } }),
    onChatDone: vi.fn((cb: typeof done) => { done = cb; return () => { done = null } })
  }
  return { api, appendMessage, startChat, abortChat, emitChunk: (id: string, text: string) => chunk?.(id, text), emitDone: (id: string) => done?.(id, { status: 'finished' }) }
}

function args(over: Partial<UseChatArgs> = {}): UseChatArgs {
  return {
    book: { id: 'book', title: '书', author: null, coverPath: null, filePath: '', sourcePath: '', addedAt: 0, lastReadCfi: null, lastReadAt: null },
    visible,
    toc: [],
    systemPrompt: '回答简洁',
    contextLimit: 8000,
    conversationId: 'conversation-a',
    onConversationCreated: vi.fn(),
    getQuotes: () => [],
    clearQuotes: vi.fn(),
    ...over
  }
}

describe('useChat 生命周期', () => {
  let root: Root
  let host: HTMLDivElement
  let state: ChatState
  let currentArgs: UseChatArgs

  function Harness(): null {
    state = useChat(currentArgs)
    return null
  }

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
  })
  afterEach(() => {
    act(() => root?.unmount())
    host.remove()
  })

  it('回答落库使用请求绑定的对话,不读取切换后的 ref', async () => {
    const h = apiHarness()
    window.api = h.api as never
    currentArgs = args()
    await act(async () => { root = createRoot(host); root.render(createElement(Harness)); await Promise.resolve() })
    await act(async () => { void state.send('问题'); await Promise.resolve() })
    currentArgs = args({ conversationId: 'conversation-b' })
    await act(async () => { root.render(createElement(Harness)); await Promise.resolve() })
    await act(async () => { h.emitChunk('request-1', '回答'); h.emitDone('request-1'); await Promise.resolve() })
    expect(h.appendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ conversationId: 'conversation-a', role: 'assistant' }))
  })

  it('发送入口同步加锁,双击只保存并启动一次', async () => {
    const h = apiHarness()
    window.api = h.api as never
    currentArgs = args()
    await act(async () => { root = createRoot(host); root.render(createElement(Harness)); await Promise.resolve() })
    await act(async () => { void state.send('一'); void state.send('二'); await Promise.resolve() })
    expect(h.appendMessage).toHaveBeenCalledTimes(1)
    expect(h.startChat).toHaveBeenCalledTimes(1)
  })

  it('startChat 尚未返回时卸载,返回后立即 abort', async () => {
    const h = apiHarness()
    let resolveStart!: (id: string) => void
    h.startChat.mockImplementationOnce(() => new Promise((resolve) => { resolveStart = resolve }))
    window.api = h.api as never
    currentArgs = args()
    await act(async () => { root = createRoot(host); root.render(createElement(Harness)); await Promise.resolve() })
    await act(async () => {
      void state.send('问题')
      await vi.waitFor(() => expect(h.startChat).toHaveBeenCalled())
    })
    act(() => root.unmount())
    await act(async () => { resolveStart('late-request'); await Promise.resolve() })
    expect(h.abortChat).toHaveBeenCalledWith('late-request')
  })

  it('IPC 失败显示中文 chat error 且释放锁', async () => {
    const h = apiHarness()
    h.appendMessage.mockRejectedValueOnce(new Error('ipc failure'))
    window.api = h.api as never
    currentArgs = args()
    await act(async () => { root = createRoot(host); root.render(createElement(Harness)); await Promise.resolve() })
    await act(async () => { await state.send('问题'); await Promise.resolve() })
    expect(state.error).toContain('聊天失败')
    expect(h.startChat).not.toHaveBeenCalled()
  })

  it('加载到空结果时不覆盖已经写入的本地用户消息', () => {
    const local = [message('conversation-new', 'user', '问题')]
    expect(mergeLoadedMessages([], local)).toEqual(local)
    expect(mergeLoadedMessages([message('conversation-new', 'user', '数据库')], local)[0].content).toBe('数据库')
  })
})
