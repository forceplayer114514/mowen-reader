// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChat, type ChatState, type UseChatArgs } from '../../src/renderer/chat/useChat'
import Sidebar, { mergeLoadedMessages } from '../../src/renderer/chat/Sidebar'
import type { ConversationWithCount, MessageRecord } from '../../src/shared/types'
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
  const startInputs: { messages: { role: string; content: string }[] }[] = []
  const abortChat = vi.fn(async () => {})
  const startChat = vi.fn(async (input: { messages: { role: string; content: string }[] }) => {
    startInputs.push(input)
    return `request-${startInputs.length}`
  })
  const deleteConversations = vi.fn(async () => {})
  const listConversations = vi.fn(async () => [] as ConversationWithCount[])
  const listMessages = vi.fn(async () => [] as MessageRecord[])
  const getSetting = vi.fn(async () => null)
  const createConversation = vi.fn(async () => ({
    id: 'conversation-new', bookId: 'book', startCfi: visible.startCfi, endCfi: visible.endCfi,
    mergedEndCfi: null, chapterLabel: visible.chapterLabel, excerpt: visible.text, createdAt: Date.now()
  }))
  const appendMessage = vi.fn(async (input: { conversationId: string; role: 'user' | 'assistant'; content: string }) =>
    message(input.conversationId, input.role, input.content))
  const api = {
    createConversation,
    deleteConversations,
    listConversations,
    listMessages,
    getSetting,
    appendMessage,
    startChat,
    abortChat,
    onChatChunk: vi.fn((cb: typeof chunk) => { chunk = cb; return () => { chunk = null } }),
    onChatDone: vi.fn((cb: typeof done) => { done = cb; return () => { done = null } })
  }
  return { api, createConversation, appendMessage, startChat, startInputs, abortChat, deleteConversations, listConversations, listMessages, getSetting, emitChunk: (id: string, text: string) => chunk?.(id, text), emitDone: (id: string) => done?.(id, { status: 'finished' }) }
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

  it('旧请求迟到 resolve 不会释放新请求的锁,新请求仍可取消', async () => {
    const h = apiHarness()
    let resolveA!: (id: string) => void
    let resolveB!: (id: string) => void
    h.startChat
      .mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveB = resolve }))
    window.api = h.api as never
    currentArgs = args({ conversationId: 'conversation-a' })
    await act(async () => { root = createRoot(host); root.render(createElement(Harness)); await Promise.resolve() })
    await act(async () => { void state.send('A'); await Promise.resolve() })

    currentArgs = args({ conversationId: 'conversation-b' })
    await act(async () => { root.render(createElement(Harness)); await Promise.resolve() })
    await act(async () => { void state.send('B'); await Promise.resolve() })
    await act(async () => { void state.send('第三次'); await Promise.resolve() })
    expect(h.startChat).toHaveBeenCalledTimes(2)

    await act(async () => { resolveA('request-a'); await Promise.resolve() })
    expect(h.abortChat).toHaveBeenCalledWith('request-a')
    expect(state.streaming).toBe('')
    await act(async () => { void state.send('仍被锁住'); await Promise.resolve() })
    expect(h.startChat).toHaveBeenCalledTimes(2)

    currentArgs = args({ conversationId: 'conversation-c' })
    await act(async () => { root.render(createElement(Harness)); await Promise.resolve() })
    await act(async () => { resolveB('request-b'); await Promise.resolve() })
    expect(h.abortChat).toHaveBeenCalledWith('request-b')
  })

  it('旧请求迟到 reject 不会清掉新请求的 streaming 状态', async () => {
    const h = apiHarness()
    let rejectA!: (error: Error) => void
    let resolveB!: (id: string) => void
    h.startChat
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectA = reject }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveB = resolve }))
    window.api = h.api as never
    currentArgs = args({ conversationId: 'conversation-a' })
    await act(async () => { root = createRoot(host); root.render(createElement(Harness)); await Promise.resolve() })
    await act(async () => { void state.send('A'); await Promise.resolve() })
    currentArgs = args({ conversationId: 'conversation-b' })
    await act(async () => { root.render(createElement(Harness)); await Promise.resolve() })
    await act(async () => { void state.send('B'); await Promise.resolve() })
    await act(async () => { rejectA(new Error('late A')); await Promise.resolve() })
    expect(state.streaming).toBe('')
    currentArgs = args({ conversationId: 'conversation-c' })
    await act(async () => { root.render(createElement(Harness)); await Promise.resolve() })
    await act(async () => { resolveB('request-b'); await Promise.resolve() })
  })

  it('旧请求 finally 不会解锁新请求,新请求仍可取消', async () => {
    const h = apiHarness()
    let resolveAssistant!: (message: MessageRecord) => void
    let nextRequest = 0
    h.startChat.mockImplementation(async () => `request-${++nextRequest}`)
    h.appendMessage.mockImplementation(async (input: { conversationId: string; role: 'user' | 'assistant'; content: string }) => {
      if (input.role === 'assistant') return new Promise((resolve) => { resolveAssistant = resolve })
      return message(input.conversationId, input.role, input.content)
    })
    window.api = h.api as never
    currentArgs = args({ conversationId: 'conversation-a' })
    await act(async () => { root = createRoot(host); root.render(createElement(Harness)); await Promise.resolve() })
    await act(async () => { void state.send('A'); await Promise.resolve() })
    await act(async () => { h.emitChunk('request-1', '回答 A'); h.emitDone('request-1'); await Promise.resolve() })
    await vi.waitFor(() => expect(h.appendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ role: 'assistant' })))

    currentArgs = args({ conversationId: 'conversation-b' })
    await act(async () => { root.render(createElement(Harness)); await Promise.resolve() })
    await act(async () => { void state.send('B'); await Promise.resolve() })
    await act(async () => { resolveAssistant(message('conversation-a', 'assistant', '回答 A')); await Promise.resolve() })
    expect(state.streaming).toBe('')
    await act(async () => { void state.send('第三次'); await Promise.resolve() })
    expect(h.startChat).toHaveBeenCalledTimes(2)

    currentArgs = args({ conversationId: 'conversation-c' })
    await act(async () => { root.render(createElement(Harness)); await Promise.resolve() })
    expect(h.abortChat).toHaveBeenCalledWith('request-2')
  })

  it('切页时迟到的创建结果会删除空对话', async () => {
    const h = apiHarness()
    let resolveCreate!: (conversation: { id: string }) => void
    h.createConversation.mockImplementationOnce(() => new Promise((resolve) => { resolveCreate = resolve as never }))
    window.api = h.api as never
    currentArgs = args({ conversationId: null })
    await act(async () => { root = createRoot(host); root.render(createElement(Harness)); await Promise.resolve() })
    await act(async () => { void state.send('问题'); await Promise.resolve() })

    currentArgs = args({ conversationId: 'conversation-b' })
    await act(async () => { root.render(createElement(Harness)); await Promise.resolve() })
    await act(async () => { resolveCreate({ id: 'conversation-empty' }); await Promise.resolve() })
    expect(h.deleteConversations).toHaveBeenCalledWith(['conversation-empty'])
  })

  it('新建对话的用户消息保存失败会删除空对话', async () => {
    const h = apiHarness()
    h.createConversation.mockResolvedValueOnce({ id: 'conversation-empty' } as never)
    h.appendMessage.mockRejectedValueOnce(new Error('append failed'))
    window.api = h.api as never
    currentArgs = args({ conversationId: null })
    await act(async () => { root = createRoot(host); root.render(createElement(Harness)); await Promise.resolve() })
    await act(async () => { await state.send('问题'); await Promise.resolve() })
    expect(h.deleteConversations).toHaveBeenCalledWith(['conversation-empty'])
  })

  it('stop 在创建对话尚未返回时取消请求并清掉忙碌状态', async () => {
    const h = apiHarness()
    let resolveCreate!: (conversation: { id: string }) => void
    h.createConversation.mockImplementationOnce(() => new Promise((resolve) => {
      resolveCreate = resolve as never
    }))
    window.api = h.api as never
    currentArgs = args({ conversationId: null })
    await act(async () => { root = createRoot(host); root.render(createElement(Harness)); await Promise.resolve() })
    await act(async () => {
      void state.send('问题')
      await vi.waitFor(() => expect(h.createConversation).toHaveBeenCalled())
    })
    act(() => state.stop())
    expect(state.streaming).toBeNull()
    await act(async () => { resolveCreate({ id: 'conversation-canceled' }); await Promise.resolve() })
    expect(h.startChat).not.toHaveBeenCalled()
    expect(h.deleteConversations).toHaveBeenCalledWith(['conversation-canceled'])
  })

  it('stop 在保存用户消息尚未返回时不启动模型且释放忙碌状态', async () => {
    const h = apiHarness()
    let rejectAppend!: (error: Error) => void
    h.appendMessage.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectAppend = reject
    }))
    window.api = h.api as never
    currentArgs = args({ conversationId: null })
    await act(async () => { root = createRoot(host); root.render(createElement(Harness)); await Promise.resolve() })
    await act(async () => {
      void state.send('问题')
      await vi.waitFor(() => expect(h.appendMessage).toHaveBeenCalled())
    })
    act(() => state.stop())
    expect(state.streaming).toBeNull()
    await act(async () => { rejectAppend(new Error('append failed')); await Promise.resolve() })
    expect(h.startChat).not.toHaveBeenCalled()
    expect(h.deleteConversations).toHaveBeenCalledWith(['conversation-new'])
  })

  it('stop 在 startChat 尚未返回时清掉 UI,迟到的 request id 会被中止', async () => {
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
    expect(state.streaming).toBe('')
    act(() => state.stop())
    expect(state.streaming).toBeNull()
    await act(async () => { resolveStart('late-request'); await Promise.resolve() })
    expect(h.abortChat).toHaveBeenCalledWith('late-request')
    expect(state.streaming).toBeNull()
    await act(async () => { await state.send('第二个问题'); await Promise.resolve() })
    expect(h.startChat).toHaveBeenCalledTimes(2)
  })

  it('stop 后保留已收到的回答,后续请求上下文包含 partial', async () => {
    const h = apiHarness()
    window.api = h.api as never
    currentArgs = args()
    await act(async () => { root = createRoot(host); root.render(createElement(Harness)); await Promise.resolve() })
    await act(async () => { void state.send('第一个问题'); await Promise.resolve() })
    await act(async () => { h.emitChunk('request-1', '回答的一半'); state.stop(); await Promise.resolve() })
    expect(state.streaming).toBeNull()
    await act(async () => { h.emitDone('request-1'); await Promise.resolve() })
    await vi.waitFor(() => expect(h.appendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      role: 'assistant', content: '回答的一半'
    })))
    await vi.waitFor(() => expect(state.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', content: '回答的一半' })
    ])))

    await act(async () => { await state.send('第二个问题') })
    expect(h.startInputs.at(-1)?.messages).toEqual(expect.arrayContaining([
      { role: 'assistant', content: '回答的一半' }
    ]))
  })

  it('清理空对话失败时显示中文错误', async () => {
    const h = apiHarness()
    h.appendMessage.mockRejectedValueOnce(new Error('append failed'))
    h.deleteConversations.mockRejectedValueOnce(new Error('delete failed'))
    window.api = h.api as never
    currentArgs = args({ conversationId: null })
    await act(async () => { root = createRoot(host); root.render(createElement(Harness)); await Promise.resolve() })
    await act(async () => { await state.send('问题') })
    await vi.waitFor(() => expect(state.error).toContain('空对话删除失败'))
  })

  it('切换会话后清掉旧失败,重试不会再次启动旧请求', async () => {
    const h = apiHarness()
    h.startChat.mockRejectedValueOnce(new Error('start failed'))
    window.api = h.api as never
    currentArgs = args({ conversationId: 'conversation-a' })
    await act(async () => { root = createRoot(host); root.render(createElement(Harness)); await Promise.resolve() })
    await act(async () => { await state.send('问题'); await Promise.resolve() })
    expect(state.error).toContain('请求发不出去')
    const starts = h.startChat.mock.calls.length

    currentArgs = args({ conversationId: 'conversation-b' })
    await act(async () => { root.render(createElement(Harness)); await Promise.resolve() })
    expect(state.error).toBeNull()
    await act(async () => { await state.retry(); await Promise.resolve() })
    expect(h.startChat).toHaveBeenCalledTimes(starts)
  })

  it('切换页面后清掉旧失败,重试不会再次启动旧请求', async () => {
    const h = apiHarness()
    h.startChat.mockRejectedValueOnce(new Error('start failed'))
    window.api = h.api as never
    currentArgs = args()
    await act(async () => { root = createRoot(host); root.render(createElement(Harness)); await Promise.resolve() })
    await act(async () => { await state.send('问题'); await Promise.resolve() })
    expect(state.error).toContain('请求发不出去')
    const starts = h.startChat.mock.calls.length

    const nextVisible = { ...visible, startCfi: 'epubcfi(/6/6!/4/2/2/1:0)', endCfi: 'epubcfi(/6/6!/4/2/8/1:0)' }
    currentArgs = args({ visible: nextVisible })
    await act(async () => { root.render(createElement(Harness)); await Promise.resolve() })
    expect(state.error).toBeNull()
    await act(async () => { await state.retry(); await Promise.resolve() })
    expect(h.startChat).toHaveBeenCalledTimes(starts)
  })

  it('Sidebar 的迟到空加载基于最新 state,不会覆盖刚落库的 assistant', async () => {
    const h = apiHarness()
    let resolveMessages!: (messages: MessageRecord[]) => void
    const conversation = {
      id: 'conversation-a', bookId: 'book', startCfi: visible.startCfi, endCfi: visible.endCfi,
      mergedEndCfi: null, chapterLabel: visible.chapterLabel, excerpt: visible.text,
      createdAt: Date.now(), messageCount: 0
    }
    h.listConversations.mockResolvedValueOnce([conversation])
    h.listMessages.mockImplementationOnce(async () => new Promise<MessageRecord[]>((resolve) => { resolveMessages = resolve }))
    window.api = h.api as never
    const book = args().book
    await act(async () => {
      root = createRoot(host)
      root.render(createElement(Sidebar, { book, engine: null, visible, toc: [], selection: null }))
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(h.listMessages).toHaveBeenCalledWith('conversation-a'))

    const input = host.querySelector('[data-testid="chat-input"]') as HTMLTextAreaElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, '问题')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="chat-send"]')?.click()
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(h.startChat).toHaveBeenCalled())
    await act(async () => {
      h.emitChunk('request-1', '回答')
      h.emitDone('request-1')
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(h.appendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ role: 'assistant' })))
    await act(async () => { resolveMessages([]); await Promise.resolve() })
    expect(host.querySelectorAll('[data-testid="message-assistant"]').length).toBe(1)
  })

  it('Sidebar 的旧对话列表响应不会覆盖新建后的列表或中止新请求', async () => {
    const h = apiHarness()
    let resolveInitial!: (items: ConversationWithCount[]) => void
    let resolveRefresh!: (items: ConversationWithCount[]) => void
    const oldConversation = {
      id: 'conversation-old', bookId: 'book', startCfi: visible.startCfi, endCfi: visible.endCfi,
      mergedEndCfi: null, chapterLabel: visible.chapterLabel, excerpt: '旧', createdAt: 1, messageCount: 1
    }
    const newConversation = {
      id: 'conversation-new', bookId: 'book', startCfi: visible.startCfi, endCfi: visible.endCfi,
      mergedEndCfi: null, chapterLabel: visible.chapterLabel, excerpt: '新', createdAt: 2, messageCount: 1
    }
    h.listConversations
      .mockImplementationOnce(() => new Promise((resolve) => { resolveInitial = resolve }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve }))
    window.api = h.api as never
    const book = args().book
    await act(async () => {
      root = createRoot(host)
      root.render(createElement(Sidebar, { book, engine: null, visible, toc: [], selection: null }))
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(h.listConversations).toHaveBeenCalledTimes(1))

    const input = host.querySelector('[data-testid="chat-input"]') as HTMLTextAreaElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, '问题')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
      host.querySelector<HTMLButtonElement>('[data-testid="chat-send"]')?.click()
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(h.listConversations).toHaveBeenCalledTimes(2))
    await act(async () => { resolveRefresh([newConversation]); await Promise.resolve() })
    await act(async () => { resolveInitial([oldConversation]); await Promise.resolve() })

    expect(h.abortChat).not.toHaveBeenCalled()
    expect(host.querySelector('[data-testid="all-conversations"]')?.textContent).toContain('1 条')
    expect(host.querySelector('[data-testid="all-conversations"]')?.textContent).not.toContain('2 条')
    expect(host.querySelectorAll('[data-testid="history-entry"]').length).toBe(0)
  })

  it('新对话删除失败时在 Sidebar 显示中文错误', async () => {
    const h = apiHarness()
    const conversation = {
      id: 'conversation-a', bookId: 'book', startCfi: visible.startCfi, endCfi: visible.endCfi,
      mergedEndCfi: null, chapterLabel: visible.chapterLabel, excerpt: visible.text,
      createdAt: Date.now(), messageCount: 1
    }
    h.listConversations.mockResolvedValueOnce([conversation])
    h.listMessages.mockResolvedValueOnce([message('conversation-a', 'user', '旧问题')])
    h.deleteConversations.mockRejectedValueOnce(new Error('delete failed'))
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    window.api = h.api as never
    const book = args().book
    await act(async () => {
      root = createRoot(host)
      root.render(createElement(Sidebar, { book, engine: null, visible, toc: [], selection: null }))
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(host.querySelector('[data-testid="message-user"]')).not.toBeNull())
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="new-conversation"]')?.click(); await Promise.resolve() })
    await vi.waitFor(() => expect(host.querySelector('[data-testid="sidebar-error"]')?.textContent).toContain('对话删除失败'))
    expect(confirm).toHaveBeenCalled()
    confirm.mockRestore()
  })

  it('加载到空结果时不覆盖已经写入的本地用户消息', () => {
    const local = [message('conversation-new', 'user', '问题')]
    expect(mergeLoadedMessages([], local)).toEqual(local)
    expect(mergeLoadedMessages([message('conversation-new', 'user', '数据库')], local)[0].content).toBe('数据库')
  })

  it('非空旧快照只补上同会话的本地新增消息', () => {
    const loaded = [message('conversation-a', 'user', '旧用户')]
    const local = [
      message('conversation-a', 'user', '旧用户'),
      message('conversation-a', 'assistant', '本地新增'),
      message('conversation-b', 'user', '别的会话')
    ]
    expect(mergeLoadedMessages(loaded, local, 'conversation-a').map((item) => item.content)).toEqual([
      '旧用户', '本地新增'
    ])
  })
})
