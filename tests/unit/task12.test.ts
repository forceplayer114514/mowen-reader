// @vitest-environment jsdom
import { act, createElement, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SettingsView from '../../src/renderer/settings/SettingsView'
import { CONNECTION_TEST_TIMEOUT_MS } from '../../src/renderer/settings/SettingsView'
import ConversationsView from '../../src/renderer/library/ConversationsView'
import type { ConversationWithBook } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function settingsApi() {
  let done: ((id: string, result: { status: 'finished' | 'stopped' | 'error'; message?: string }) => void) | null = null
  return {
    getSetting: vi.fn(async () => null),
    hasApiKey: vi.fn(async () => false),
    setSetting: vi.fn(async () => {}),
    setApiKey: vi.fn(async () => {}),
    clearApiKey: vi.fn(async () => {}),
    listModels: vi.fn(async () => ({ models: ['model-a', 'model-b'], endpoint: 'https://api.example/v1' })),
    abortChat: vi.fn(async () => {}),
    startChat: vi.fn(async () => 'request-1'),
    onChatChunk: vi.fn(() => () => {}),
    onChatDone: vi.fn((cb: typeof done) => {
      done = cb
      return () => { done = null }
    }),
    emitDone: (id: string, result: { status: 'finished' | 'stopped' | 'error'; message?: string }) => done?.(id, result)
  }
}

function fill(testId: string, value: string): void {
  const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-testid="${testId}"]`)
  if (!input) throw new Error(`missing ${testId}`)
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('Task 12 设置与对话管理', () => {
  let root: Root
  let host: HTMLDivElement

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
  })

  afterEach(() => {
    act(() => root?.unmount())
    host.remove()
  })

  it('保存先写接口再写新密钥,留空密钥不触碰密钥通道', async () => {
    const api = settingsApi()
    window.api = api as never
    await act(async () => {
      root = createRoot(host)
      root.render(createElement(SettingsView, { onBack: vi.fn() }))
      await Promise.resolve()
    })
    await act(async () => {
      fill('settings-endpoint', 'https://api.example/v1')
      fill('settings-model', 'model')
      fill('settings-limit', '1000')
      host.querySelector<HTMLButtonElement>('[data-testid="settings-save"]')?.click()
      await Promise.resolve()
    })
    expect(api.setApiKey).not.toHaveBeenCalled()
    expect(api.setSetting.mock.invocationCallOrder[0]).toBeLessThan(api.setSetting.mock.invocationCallOrder[1])
    expect(api.setSetting).toHaveBeenCalledWith('llmEndpoint', 'https://api.example/v1')
  })

  it('有新密钥时接口写入先于密钥,无效上限不保存', async () => {
    const api = settingsApi()
    window.api = api as never
    await act(async () => {
      root = createRoot(host)
      root.render(createElement(SettingsView, { onBack: vi.fn() }))
      await Promise.resolve()
    })
    await act(async () => {
      fill('settings-endpoint', 'https://api.example/v1')
      fill('settings-model', 'model')
      fill('settings-apikey', 'fresh-key')
      fill('settings-limit', 'not-a-number')
      host.querySelector<HTMLButtonElement>('[data-testid="settings-save"]')?.click()
      await Promise.resolve()
    })
    expect(api.setSetting).not.toHaveBeenCalled()
    expect(api.setApiKey).not.toHaveBeenCalled()
    expect(host.querySelector('[data-testid="settings-status"]')?.textContent).toContain('上下文上限')
  })

  it('测试连接只接受匹配请求 id 的收尾事件', async () => {
    const api = settingsApi()
    window.api = api as never
    await act(async () => {
      root = createRoot(host)
      root.render(createElement(SettingsView, { onBack: vi.fn() }))
      await Promise.resolve()
    })
    await act(async () => {
      fill('settings-endpoint', 'https://api.example/v1')
      fill('settings-model', 'model')
      fill('settings-apikey', 'fresh-key')
      await Promise.resolve()
    })
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="settings-test"]')?.click()
      await Promise.resolve()
    })
    expect(api.setSetting).toHaveBeenCalledWith('llmEndpoint', 'https://api.example/v1')
    expect(api.setSetting).toHaveBeenCalledWith('llmModel', 'model')
    expect(api.setApiKey).toHaveBeenCalledWith('fresh-key')
    expect(api.setApiKey.mock.invocationCallOrder[0]).toBeGreaterThan(api.setSetting.mock.invocationCallOrder[0])
    expect(api.startChat.mock.invocationCallOrder[0]).toBeGreaterThan(api.setApiKey.mock.invocationCallOrder[0])
    await act(async () => { api.emitDone('other', { status: 'finished' }) })
    expect(host.querySelector('[data-testid="settings-status"]')?.textContent).not.toContain('连接成功')
    await act(async () => { api.emitDone('request-1', { status: 'finished' }) })
    expect(host.querySelector('[data-testid="settings-status"]')?.textContent).toContain('连接成功')
  })

  it('填写接口和密钥后可获取并选择模型', async () => {
    const api = settingsApi()
    window.api = api as never
    await act(async () => {
      root = createRoot(host)
      root.render(createElement(SettingsView, { onBack: vi.fn() }))
      await Promise.resolve()
    })
    await act(async () => {
      fill('settings-endpoint', 'https://api.example/v1')
      fill('settings-apikey', 'fresh-key')
      host.querySelector<HTMLButtonElement>('[data-testid="settings-fetch-models"]')?.click()
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(host.querySelectorAll('[data-testid="settings-model"] option')).toHaveLength(3))
    expect(api.listModels).toHaveBeenCalledTimes(1)
    expect(api.setApiKey).toHaveBeenCalledWith('fresh-key')
    const select = host.querySelector<HTMLSelectElement>('[data-testid="settings-model"]')!
    act(() => {
      select.value = 'model-b'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(select.value).toBe('model-b')
  })

  it('连接测试超时会中止请求并清理等待状态', async () => {
    const api = settingsApi()
    window.api = api as never
    try {
      await act(async () => {
        root = createRoot(host)
        root.render(createElement(SettingsView, { onBack: vi.fn() }))
        await Promise.resolve()
      })
      vi.useFakeTimers()
      await act(async () => {
        fill('settings-endpoint', 'https://api.example/v1')
        fill('settings-model', 'model')
        host.querySelector<HTMLButtonElement>('[data-testid="settings-test"]')?.click()
        await Promise.resolve()
      })
      await act(async () => { vi.advanceTimersByTime(CONNECTION_TEST_TIMEOUT_MS) })
      expect(api.abortChat).toHaveBeenCalledWith('request-1')
      expect(host.querySelector('[data-testid="settings-status"]')?.textContent).toContain('连接测试超时')
      expect(host.querySelector<HTMLButtonElement>('[data-testid="settings-test"]')?.textContent).toContain('测试连接')
    } finally {
      vi.useRealTimers()
    }
  })

  it('连接测试尚未拿到请求 id 就卸载时,迟到 id 会立即中止且不装监听器', async () => {
    let resolveStart!: (id: string) => void
    const api = settingsApi()
    api.startChat.mockImplementation(() => new Promise<string>((resolve) => { resolveStart = resolve }))
    window.api = api as never
    await act(async () => {
      root = createRoot(host)
      root.render(createElement(SettingsView, { onBack: vi.fn() }))
      await Promise.resolve()
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(host.querySelector('[data-testid="settings-endpoint"]')).not.toBeNull())
    await act(async () => {
      fill('settings-endpoint', 'https://api.example/v1')
      fill('settings-model', 'model')
      host.querySelector<HTMLButtonElement>('[data-testid="settings-test"]')?.click()
      await Promise.resolve()
    })
    expect(api.startChat).toHaveBeenCalled()
    act(() => root.unmount())
    await act(async () => { resolveStart('late-request'); await Promise.resolve() })
    expect(api.abortChat).toHaveBeenCalledWith('late-request')
    expect(api.onChatDone).not.toHaveBeenCalled()
  })

  it('停止连接测试会中止并立即清理监听与等待状态', async () => {
    const api = settingsApi()
    window.api = api as never
    await act(async () => {
      root = createRoot(host)
      root.render(createElement(SettingsView, { onBack: vi.fn() }))
      await Promise.resolve()
    })
    await act(async () => {
      fill('settings-endpoint', 'https://api.example/v1')
      fill('settings-model', 'model')
      host.querySelector<HTMLButtonElement>('[data-testid="settings-test"]')?.click()
      await Promise.resolve()
    })
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="settings-test"]')?.click()
      await Promise.resolve()
    })
    expect(api.abortChat).toHaveBeenCalledWith('request-1')
    expect(host.querySelector('[data-testid="settings-status"]')?.textContent).toContain('连接测试已停止')
    expect(host.querySelector<HTMLButtonElement>('[data-testid="settings-test"]')?.textContent).toContain('测试连接')
  })

  it('StrictMode 双 effect 后仍可清除密钥并测试连接', async () => {
    const api = settingsApi()
    window.api = api as never
    await act(async () => {
      root = createRoot(host)
      root.render(createElement(StrictMode, null, createElement(SettingsView, { onBack: vi.fn() })))
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(host.querySelector('[data-testid="settings-endpoint"]')).not.toBeNull())
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="settings-clear"]')?.click()
      await Promise.resolve()
    })
    expect(api.clearApiKey).toHaveBeenCalledTimes(1)
    await act(async () => {
      fill('settings-endpoint', 'https://api.example/v1')
      fill('settings-model', 'model')
      host.querySelector<HTMLButtonElement>('[data-testid="settings-test"]')?.click()
      await Promise.resolve()
    })
    expect(api.startChat).toHaveBeenCalledTimes(1)
  })

  it('按书分组并批量删除时确认框会说明连同消息删除', async () => {
    const book = { id: 'book-a', title: '甲书', author: '作者', coverPath: null, filePath: '', sourcePath: '', addedAt: 1, lastReadCfi: null, lastReadAt: null }
    const rows: ConversationWithBook[] = [
      { id: 'a', bookId: 'book-a', bookTitle: '甲书', startCfi: 'a', endCfi: 'b', mergedEndCfi: null, chapterLabel: '第一章', excerpt: '开头', createdAt: Date.now(), messageCount: 2 },
      { id: 'b', bookId: 'book-a', bookTitle: '甲书', startCfi: 'c', endCfi: 'd', mergedEndCfi: 'd', chapterLabel: '第二章', excerpt: '后来', createdAt: Date.now(), messageCount: 3 }
    ]
    const api = { listBooks: vi.fn().mockResolvedValue([book]), listAllConversations: vi.fn().mockResolvedValueOnce(rows).mockResolvedValueOnce([]), deleteConversations: vi.fn().mockResolvedValue(undefined) }
    window.api = api as never
    await act(async () => {
      root = createRoot(host)
      root.render(createElement(ConversationsView, { onBack: vi.fn() }))
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(host.querySelector('[data-testid="conversation-book"]')).not.toBeNull())
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="管理《甲书》的对话"]')?.click() })
    expect(host.querySelectorAll('[data-testid="chapter-group"]')).toHaveLength(2)
    expect(host.querySelectorAll('[data-testid="conversation-row"]')).toHaveLength(2)
    expect(host.textContent).toContain('甲书')
    expect(host.textContent).toContain('含下一屏')
    await act(async () => {
      for (const checkbox of host.querySelectorAll<HTMLInputElement>('.conversation-row input')) checkbox.click()
      host.querySelector<HTMLButtonElement>('[data-testid="conversation-delete"]')?.click()
      await Promise.resolve()
    })
    expect(host.querySelector('[data-testid="confirm-conversations-delete"]')?.textContent).toMatch(/消息.*删除/)
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="confirm-conversations-delete-yes"]')?.click()
      await Promise.resolve()
    })
    expect(api.deleteConversations).toHaveBeenCalledWith(['a', 'b'])
  })

  it('过期的旧列表响应不会覆盖最新列表响应', async () => {
    let resolveOld!: (rows: ConversationWithBook[]) => void
    let resolveNew!: (rows: ConversationWithBook[]) => void
    const oldRow: ConversationWithBook = { id: 'old', bookId: 'old-book', bookTitle: '旧书', startCfi: 'a', endCfi: 'b', mergedEndCfi: null, chapterLabel: null, excerpt: '旧', createdAt: 1, messageCount: 1 }
    const newRow: ConversationWithBook = { ...oldRow, id: 'new', bookId: 'new-book', bookTitle: '新书', excerpt: '新' }
    const book = { id: 'new-book', title: '新书', author: null, coverPath: null, filePath: '', sourcePath: '', addedAt: 1, lastReadCfi: null, lastReadAt: null }
    const api = {
      listBooks: vi.fn().mockResolvedValue([book]),
      listAllConversations: vi.fn()
        .mockImplementationOnce(() => new Promise<ConversationWithBook[]>((resolve) => { resolveOld = resolve }))
        .mockImplementationOnce(() => new Promise<ConversationWithBook[]>((resolve) => { resolveNew = resolve })),
      deleteConversations: vi.fn()
    }
    window.api = api as never
    await act(async () => {
      root = createRoot(host)
      root.render(createElement(StrictMode, null, createElement(ConversationsView, { onBack: vi.fn() })))
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(api.listAllConversations).toHaveBeenCalledTimes(2))
    await act(async () => { resolveNew([newRow]); await Promise.resolve() })
    await act(async () => { resolveOld([oldRow]); await Promise.resolve() })
    expect(host.textContent).toContain('新书')
    expect(host.textContent).not.toContain('旧书')
  })

  it('卸载后迟到的列表响应不会写入状态', async () => {
    let resolveRows!: (rows: ConversationWithBook[]) => void
    const api = {
      listBooks: vi.fn().mockResolvedValue([]),
      listAllConversations: vi.fn(() => new Promise<ConversationWithBook[]>((resolve) => { resolveRows = resolve })),
      deleteConversations: vi.fn()
    }
    window.api = api as never
    await act(async () => {
      root = createRoot(host)
      root.render(createElement(ConversationsView, { onBack: vi.fn() }))
      await Promise.resolve()
    })
    act(() => root.unmount())
    await act(async () => { resolveRows([]); await Promise.resolve() })
    expect(host.textContent).toBe('')
  })
})
