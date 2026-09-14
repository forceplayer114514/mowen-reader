// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SettingsView from '../../src/renderer/settings/SettingsView'
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
      host.querySelector<HTMLButtonElement>('[data-testid="settings-test"]')?.click()
      await Promise.resolve()
    })
    await act(async () => { api.emitDone('other', { status: 'finished' }) })
    expect(host.querySelector('[data-testid="settings-status"]')?.textContent).not.toContain('连接成功')
    await act(async () => { api.emitDone('request-1', { status: 'finished' }) })
    expect(host.querySelector('[data-testid="settings-status"]')?.textContent).toContain('连接成功')
  })

  it('按书分组并批量删除时确认消息会说明连同消息删除', async () => {
    const rows: ConversationWithBook[] = [
      { id: 'a', bookId: 'book-a', bookTitle: '甲书', startCfi: 'a', endCfi: 'b', mergedEndCfi: null, chapterLabel: '第一章', excerpt: '开头', createdAt: Date.now(), messageCount: 2 },
      { id: 'b', bookId: 'book-a', bookTitle: '甲书', startCfi: 'c', endCfi: 'd', mergedEndCfi: 'd', chapterLabel: '第二章', excerpt: '后来', createdAt: Date.now(), messageCount: 3 }
    ]
    const api = { listAllConversations: vi.fn().mockResolvedValueOnce(rows).mockResolvedValueOnce([]), deleteConversations: vi.fn().mockResolvedValue(undefined) }
    window.api = api as never
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await act(async () => {
      root = createRoot(host)
      root.render(createElement(ConversationsView, { onBack: vi.fn() }))
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(host.querySelectorAll('[data-testid="conversation-row"]')).toHaveLength(2))
    expect(host.textContent).toContain('甲书')
    expect(host.textContent).toContain('（+下一页）')
    await act(async () => {
      for (const checkbox of host.querySelectorAll<HTMLInputElement>('.conversation-row input')) checkbox.click()
      host.querySelector<HTMLButtonElement>('[data-testid="conversation-delete"]')?.click()
      await Promise.resolve()
    })
    expect(confirm.mock.calls[0]?.[0]).toMatch(/消息.*删除/)
    expect(api.deleteConversations).toHaveBeenCalledWith(['a', 'b'])
    confirm.mockRestore()
  })
})
