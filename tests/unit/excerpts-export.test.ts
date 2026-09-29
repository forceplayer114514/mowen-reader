import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 主进程数据库句柄是模块作用域懒打开；导出通道本身不碰库，
// 但 import 链会经过 secrets 的数据目录解析，赶在第一次使用前定下来即可。
process.env.READER_USER_DATA = mkdtempSync(join(tmpdir(), 'reader-excerpts-'))

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: never[]) => unknown>(),
  showSaveDialog: vi.fn(async (_options: unknown) => ({ canceled: true as boolean, filePath: undefined as string | undefined }))
}))

vi.mock('electron', () => ({
  webContents: { getAllWebContents: () => [] },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: never[]) => unknown): void => {
      mocks.handlers.set(channel, fn)
    }
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: (options: unknown) => mocks.showSaveDialog(options)
  },
  shell: { openExternal: vi.fn(async () => {}) }
}))

vi.mock('../../src/main/llm/client', () => ({
  streamChat: vi.fn(),
  listModels: vi.fn()
}))

import { registerIpc } from '../../src/main/ipc'

registerIpc()

function call(channel: string, ...args: unknown[]): unknown {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`没有注册这个通道:${channel}`)
  return handler({}, ...(args as never[]))
}

beforeEach(() => {
  mocks.showSaveDialog.mockReset()
  mocks.showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined })
})

describe('摘录导出通道 excerpts:export', () => {
  it('已注册且拒绝无效输入', async () => {
    expect(mocks.handlers.has('excerpts:export')).toBe(true)
    for (const bad of [null, {}, { markdown: '' }, { markdown: '   ' }, { markdown: 'x'.repeat(2_000_001) }]) {
      await expect(call('excerpts:export', bad) as Promise<unknown>).rejects.toThrow()
    }
    expect(mocks.showSaveDialog).not.toHaveBeenCalled()
  })

  it('用户取消时返回 saved:false 且不写文件', async () => {
    await expect(call('excerpts:export', { suggestedName: '书.md', markdown: '# 摘录' }) as Promise<unknown>)
      .resolves.toEqual({ saved: false })
  })

  it('确认后把正文原样写入用户选择的位置', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reader-excerpts-out-'))
    const target = join(dir, '摘录.md')
    mocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: target })
    await expect(call('excerpts:export', { suggestedName: '摘录.md', markdown: '# 《摘录》\n\n> 原文\n' }) as Promise<unknown>)
      .resolves.toEqual({ saved: true })
    expect(readFileSync(target, 'utf-8')).toBe('# 《摘录》\n\n> 原文\n')
  })

  it('默认文件名被清洗：目录穿越拼不出路径分隔符', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reader-excerpts-out-'))
    const target = join(dir, 'out.md')
    mocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: target })
    await (call('excerpts:export', { suggestedName: '../../etc/passwd.md', markdown: '# 摘录' }) as Promise<unknown>)
    const defaultPath = mocks.showSaveDialog.mock.calls[0][0] as { defaultPath: string }
    expect(defaultPath.defaultPath).not.toContain('/')
    expect(defaultPath.defaultPath.endsWith('.md')).toBe(true)
  })
})
