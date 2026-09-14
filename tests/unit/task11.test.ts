// @vitest-environment jsdom
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Sidebar from '../../src/renderer/chat/Sidebar'
import ConversationView from '../../src/renderer/chat/ConversationView'
import type { ChatState } from '../../src/renderer/chat/useChat'
import { createRestoreRelocationGate } from '../../src/renderer/reader/ReaderView'
import type { ConversationWithCount, MessageRecord } from '../../src/shared/types'
import type { ReaderEngine, VisibleRange } from '../../src/renderer/reader/types'
import type { SelectionStore } from '../../src/renderer/reader/selection'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const first: VisibleRange = {
  text: '第一页正文', startCfi: 'epubcfi(/6/4!/4/2/2/1:0)', endCfi: 'epubcfi(/6/4!/4/2/8/1:0)',
  rangeCfi: 'epubcfi(/6/4!/4/2,/2/1:0,/8/1:0)', approximate: false,
  chapterHref: 'Text/ch1.xhtml', chapterLabel: '第一章', page: 47, totalPages: 100
}
const second: VisibleRange = { ...first,
  text: '第二页正文', startCfi: 'epubcfi(/6/4!/4/2/10/1:0)', endCfi: 'epubcfi(/6/4!/4/2/16/1:0)',
  rangeCfi: 'epubcfi(/6/4!/4/2,/10/1:0,/16/1:0)', page: 48
}

function message(id: string): MessageRecord {
  return { id, conversationId: 'old', role: 'user', content: '旧问题', quotes: [], createdAt: 1 }
}

function makeHarness() {
  const relocated = new Set<() => void>()
  const engine = {
    onRelocated: vi.fn((cb: () => void) => { relocated.add(cb); return () => { relocated.delete(cb) } }),
    getVisible: vi.fn(async () => second),
    setSpread: vi.fn(async () => {}),
    onSelected: vi.fn(() => () => {}),
    clearHighlights: vi.fn(),
    addHighlight: vi.fn(),
    removeHighlight: vi.fn()
  } as unknown as ReaderEngine
  const conversation: ConversationWithCount = {
    id: 'old', bookId: 'book', startCfi: first.startCfi, endCfi: first.endCfi,
    mergedEndCfi: null, chapterLabel: first.chapterLabel, excerpt: first.text,
    createdAt: 1, messageCount: 1
  }
  const api = {
    listConversations: vi.fn(async () => [conversation]),
    listMessages: vi.fn(async () => [message('old-user')]),
    getSetting: vi.fn(async () => null),
    setSetting: vi.fn(async () => {}),
    setConversationMerge: vi.fn(async () => {}),
    deleteConversations: vi.fn(async () => {}),
    createConversation: vi.fn(),
    appendMessage: vi.fn(),
    startChat: vi.fn(),
    abortChat: vi.fn(async () => {}),
    onChatChunk: vi.fn(() => () => {}),
    onChatDone: vi.fn(() => () => {})
  }
  return { engine, api, trigger: () => { for (const cb of [...relocated]) cb() } }
}

function SpreadHarness({ h }: { h: ReturnType<typeof makeHarness> }): React.ReactElement {
  const [spread, setSpread] = useState(false)
  return createElement(Sidebar, {
    book, engine: h.engine, visible: first, toc: [], selection: null, spread,
    onSetSpread: async (on) => { await h.engine.setSpread(on); setSpread(on) }
  })
}

const book = { id: 'book', title: '书', author: null, coverPath: null, filePath: '', sourcePath: '', addedAt: 0, lastReadCfi: null, lastReadAt: null }

describe('Task 11 侧边栏接线', () => {
  let root: Root
  let host: HTMLDivElement

  beforeEach(() => { host = document.createElement('div'); document.body.append(host) })
  afterEach(() => { act(() => root?.unmount()); host.remove() })

  it('relocation 清掉旧会话消息和所有高亮,底部回到空对话', async () => {
    const h = makeHarness()
    const selection = {
      list: vi.fn(() => [{ cfiRange: 'r', text: '引用' }]),
      subscribe: vi.fn(() => () => {}),
      clear: vi.fn(), toggle: vi.fn(), dispose: vi.fn()
    } as unknown as SelectionStore
    window.api = h.api as never
    await act(async () => { root = createRoot(host); root.render(createElement(Sidebar, { book, engine: h.engine, visible: first, toc: [], selection })); await Promise.resolve() })
    await vi.waitFor(() => expect(h.api.listConversations).toHaveBeenCalled())
    await vi.waitFor(() => expect(h.api.listMessages).toHaveBeenCalled())
    await vi.waitFor(() => expect(host.querySelector('[data-testid="message-user"]')).not.toBeNull())

    await act(async () => { h.trigger(); await vi.waitFor(() => expect(selection.clear).toHaveBeenCalled()) })
    expect(host.querySelector('[data-testid="message-user"]')).toBeNull()
    expect(host.querySelector('[data-testid="chat-input"]')).not.toBeNull()
  })

  it('合并下一页打开双页并把已有会话终点写入数据库', async () => {
    const h = makeHarness()
    window.api = h.api as never
    await act(async () => { root = createRoot(host); root.render(createElement(Sidebar, { book, engine: h.engine, visible: first, toc: [], selection: null })); await Promise.resolve() })
    await vi.waitFor(() => expect(h.api.listConversations).toHaveBeenCalled())
    await vi.waitFor(() => expect(h.api.listMessages).toHaveBeenCalled())
    await vi.waitFor(() => expect(host.querySelector('[data-testid="message-user"]')).not.toBeNull())
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="merge-next-page"]')?.click(); await Promise.resolve() })
    expect(h.engine.setSpread).toHaveBeenCalledWith(true)
    expect(h.api.setConversationMerge).toHaveBeenCalledWith('old', second.endCfi)
  })

  it('尚未创建会话时,首次发送使用合并后的终点 CFI', async () => {
    const h = makeHarness()
    h.api.listConversations.mockResolvedValue([])
    h.api.createConversation.mockResolvedValue({
      id: 'new', bookId: 'book', startCfi: first.startCfi, endCfi: second.endCfi,
      mergedEndCfi: null, chapterLabel: first.chapterLabel, excerpt: first.text, createdAt: 1
    })
    h.api.appendMessage.mockResolvedValue({ id: 'msg', conversationId: 'new', role: 'user', content: '问题', quotes: [], createdAt: 1 })
    h.api.startChat.mockResolvedValue('request-1')
    window.api = h.api as never
    await act(async () => {
      root = createRoot(host)
      root.render(createElement(SpreadHarness, { h }))
      await Promise.resolve()
    })
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="merge-next-page"]')?.click(); await Promise.resolve() })
    await vi.waitFor(() => expect(h.engine.setSpread).toHaveBeenCalledWith(true))
    const input = host.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, '问题')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      host.querySelector<HTMLButtonElement>('[data-testid="chat-send"]')?.click()
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(h.api.createConversation).toHaveBeenCalledWith(expect.objectContaining({ endCfi: first.endCfi })))
    expect(h.api.setConversationMerge).toHaveBeenCalledWith('new', second.endCfi)
  })

  it('合并写入失败回滚后,新会话不携带旧的合并终点', async () => {
    const h = makeHarness()
    h.api.setConversationMerge.mockRejectedValueOnce(new Error('merge failed'))
    h.api.createConversation.mockResolvedValue({
      id: 'new', bookId: 'book', startCfi: first.startCfi, endCfi: first.endCfi,
      mergedEndCfi: null, chapterLabel: first.chapterLabel, excerpt: first.text, createdAt: 1
    })
    h.api.appendMessage.mockResolvedValue({ id: 'new-msg', conversationId: 'new', role: 'user', content: '新问题', quotes: [], createdAt: 1 })
    h.api.startChat.mockResolvedValue('request-new')
    window.api = h.api as never
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await act(async () => {
      root = createRoot(host)
      root.render(createElement(SpreadHarness, { h }))
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(host.querySelector('[data-testid="message-user"]')).not.toBeNull())
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="merge-next-page"]')?.click(); await Promise.resolve() })
    await vi.waitFor(() => expect(h.api.setConversationMerge).toHaveBeenCalledWith('old', second.endCfi))
    await vi.waitFor(() => expect(h.engine.setSpread).toHaveBeenCalledWith(false))
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="new-conversation"]')?.click(); await Promise.resolve() })
    const input = host.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, '新问题')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      host.querySelector<HTMLButtonElement>('[data-testid="chat-send"]')?.click()
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(h.api.createConversation).toHaveBeenCalled())
    expect(h.api.setConversationMerge).toHaveBeenCalledTimes(1)
    confirm.mockRestore()
  })

  it('恢复 lastReadCfi 期间的 relocation 不切换对话也不清高亮', async () => {
    const h = makeHarness()
    const gate = createRestoreRelocationGate(true)
    const selection = {
      list: vi.fn(() => []), subscribe: vi.fn(() => () => {}), clear: vi.fn(),
      toggle: vi.fn(), dispose: vi.fn()
    } as unknown as SelectionStore
    window.api = h.api as never
    let restoring = true
    const render = () => root.render(createElement(Sidebar, {
      book, engine: h.engine, visible: first, toc: [], selection, restoring
    }))
    h.engine.onRelocated(() => {
      if (gate.consumeRelocation()) {
        restoring = false
        render()
      }
    })
    await act(async () => {
      root = createRoot(host)
      render()
      await Promise.resolve()
    })
    await act(async () => { h.trigger(); await Promise.resolve() })
    expect(selection.clear).not.toHaveBeenCalled()
    gate.finishDisplay()
    await act(async () => { h.trigger(); await Promise.resolve() })
    expect(selection.clear).not.toHaveBeenCalled()
    await act(async () => { h.trigger(); await Promise.resolve() })
    await vi.waitFor(() => expect(selection.clear).toHaveBeenCalled())
  })

  it('恢复 display 完成后只在下一次 relocation 解除恢复保护', () => {
    const gate = createRestoreRelocationGate(true)
    expect(gate.restoring).toBe(true)
    expect(gate.consumeRelocation()).toBe(false)
    gate.finishDisplay()
    expect(gate.restoring).toBe(false)
    expect(gate.consumeRelocation()).toBe(true)
    expect(gate.consumeRelocation()).toBe(false)
  })

  it('恢复失败取消等待后,后续 relocation 不会再次解除保护', () => {
    const gate = createRestoreRelocationGate(true)
    gate.finishDisplay()
    gate.cancel()
    expect(gate.restoring).toBe(false)
    expect(gate.consumeRelocation()).toBe(false)
  })

  it('空会话点击新对话不弹确认也不删除', async () => {
    const h = makeHarness()
    h.api.listConversations.mockResolvedValue([])
    const confirm = vi.spyOn(window, 'confirm')
    window.api = h.api as never
    await act(async () => {
      root = createRoot(host)
      root.render(createElement(Sidebar, { book, engine: h.engine, visible: first, toc: [], selection: null }))
      await Promise.resolve()
    })
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="new-conversation"]')?.click(); await Promise.resolve() })
    expect(confirm).not.toHaveBeenCalled()
    expect(h.api.deleteConversations).not.toHaveBeenCalled()
    confirm.mockRestore()
  })

  it('保留本页当前对话时不删除旧会话,并回到底部空对话', async () => {
    const h = makeHarness()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    window.api = h.api as never
    await act(async () => {
      root = createRoot(host)
      root.render(createElement(Sidebar, { book, engine: h.engine, visible: first, toc: [], selection: null }))
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(host.querySelector('[data-testid="message-user"]')).not.toBeNull())
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="new-conversation"]')?.click(); await Promise.resolve() })
    expect(confirm).toHaveBeenCalledWith('保留本页当前对话?')
    expect(h.api.deleteConversations).not.toHaveBeenCalled()
    expect(host.querySelector('[data-testid="message-user"]')).toBeNull()
    confirm.mockRestore()
  })

  it('新会话的合并写入失败只提示,不阻断模型请求', async () => {
    const h = makeHarness()
    h.api.listConversations.mockResolvedValue([])
    h.api.createConversation.mockResolvedValue({
      id: 'new', bookId: 'book', startCfi: first.startCfi, endCfi: first.endCfi,
      mergedEndCfi: null, chapterLabel: first.chapterLabel, excerpt: first.text, createdAt: 1
    })
    h.api.appendMessage.mockResolvedValue({ id: 'msg', conversationId: 'new', role: 'user', content: '问题', quotes: [], createdAt: 1 })
    h.api.startChat.mockResolvedValue('request-1')
    h.api.setConversationMerge.mockRejectedValueOnce(new Error('merge failed'))
    window.api = h.api as never
    await act(async () => {
      root = createRoot(host)
      root.render(createElement(Sidebar, { book, engine: h.engine, visible: first, toc: [], selection: null }))
      await Promise.resolve()
    })
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="merge-next-page"]')?.click(); await Promise.resolve() })
    const input = host.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, '问题')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      host.querySelector<HTMLButtonElement>('[data-testid="chat-send"]')?.click()
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(h.api.startChat).toHaveBeenCalled())
    expect(host.querySelector('[data-testid="sidebar-error"]')?.textContent).toContain('合并范围保存失败')
  })

  it('最后一页禁用合并按钮', async () => {
    const h = makeHarness()
    window.api = h.api as never
    const last = { ...first, page: 100, totalPages: 100 }
    await act(async () => {
      root = createRoot(host)
      root.render(createElement(Sidebar, { book, engine: h.engine, visible: last, toc: [], selection: null }))
      await Promise.resolve()
    })
    expect(host.querySelector<HTMLButtonElement>('[data-testid="merge-next-page"]')?.disabled).toBe(true)
  })

  it('模型响应进行中禁用新对话按钮,不触发确认或删除', () => {
    const onNewConversation = vi.fn()
    const chat = {
      messages: [], streaming: '', error: null, send: vi.fn(async () => {}), stop: vi.fn(),
      retry: vi.fn(async () => {}), setMessages: vi.fn()
    } as unknown as ChatState
    act(() => {
      root = createRoot(host)
      root.render(createElement(ConversationView, { chat, quotes: [], onRemoveQuote: vi.fn(), onNewConversation }))
    })
    const button = host.querySelector<HTMLButtonElement>('[data-testid="new-conversation"]')!
    expect(button.disabled).toBe(true)
    button.click()
    expect(onNewConversation).not.toHaveBeenCalled()
  })
})
