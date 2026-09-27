import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { app } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { openDatabase } from '../../src/main/db'
import { insertBook } from '../../src/main/db/books'
import { getReadingStats } from '../../src/main/db/reading-stats'
import { attachReadingStats, registerReadingStats } from '../../src/main/reading-stats'

const mocks = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), idle: vi.fn(() => 0) }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    app: new EventEmitter(),
    ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => mocks.handlers.set(name, handler) },
    powerMonitor: Object.assign(new EventEmitter(), { getSystemIdleTime: mocks.idle })
  }
})
import { powerMonitor } from 'electron'

const windows: EventEmitter[] = []
afterEach(() => {
  for (const win of windows.splice(0)) win.emit('closed')
  vi.useRealTimers()
  mocks.idle.mockReturnValue(0)
})

function setup() {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(new Date(2026, 8, 28, 12))
  const db = openDatabase(':memory:')
  insertBook(db, { id: 'a', title: '书', author: null, coverPath: null, filePath: '/a.epub',
    sourcePath: '', addedAt: 0, lastReadAt: null, lastReadCfi: null })
  const state = { focused: true, visible: true, minimized: false }
  const mainFrame = {}
  const webContents = Object.assign(new EventEmitter(), { id: 1, mainFrame, isDestroyed: () => false, send: vi.fn() })
  const win = Object.assign(new EventEmitter(), { webContents, isDestroyed: () => false,
    isFocused: () => state.focused, isVisible: () => state.visible, isMinimized: () => state.minimized })
  windows.push(win)
  registerReadingStats(() => db)
  attachReadingStats(win as unknown as BrowserWindow, () => db)
  const event = { sender: webContents, senderFrame: mainFrame }
  const start = (id: unknown) => mocks.handlers.get('reading:book')!(event, id)
  const stats = () => mocks.handlers.get('reading:stats')!(event)
  return { db, win, webContents, state, start, stats }
}

it('实际生命周期只累计前台未闲置阅读，blur/minimize/hide/锁屏/休眠立即暂停', () => {
  const h = setup(); h.start('a')
  vi.advanceTimersByTime(2000)
  h.state.focused = false; h.win.emit('blur'); vi.advanceTimersByTime(2000)
  expect(h.stats().books[0].milliseconds).toBe(2000)
  h.state.focused = true; h.win.emit('focus'); vi.advanceTimersByTime(1000)
  h.state.minimized = true; h.win.emit('minimize'); vi.advanceTimersByTime(2000)
  h.state.minimized = false; vi.advanceTimersByTime(2000)
  h.state.visible = false; h.win.emit('hide'); vi.advanceTimersByTime(2000)
  h.state.visible = true; vi.advanceTimersByTime(2000)
  powerMonitor.emit('lock-screen'); vi.advanceTimersByTime(2000)
  powerMonitor.emit('unlock-screen'); vi.advanceTimersByTime(1000)
  powerMonitor.emit('suspend'); vi.advanceTimersByTime(2000)
  powerMonitor.emit('resume'); vi.advanceTimersByTime(1000)
  const beforeIdle = h.stats().books[0].milliseconds
  mocks.idle.mockReturnValue(300); vi.advanceTimersByTime(4000)
  expect(h.stats().books[0].milliseconds).toBe(beforeIdle + 1000) // 最多一秒采样边界
  mocks.idle.mockReturnValue(0); vi.advanceTimersByTime(2000)
  expect(h.stats().books[0].milliseconds).toBe(beforeIdle + 2000)
  app.emit('before-quit')
  vi.advanceTimersByTime(500)
  expect(getReadingStats(h.db).books[0].milliseconds).toBe(beforeIdle + 2000)
})

it('主框架 IPC 校验，重载/崩溃停止旧会话，关闭时补存且移除监听', () => {
  const h = setup()
  expect(() => h.start('missing')).toThrow('阅读书籍无效')
  expect(() => mocks.handlers.get('reading:book')!({ sender: h.webContents, senderFrame: {} }, 'a')).toThrow('阅读窗口无效')
  h.start('a'); vi.advanceTimersByTime(2000)
  h.webContents.emit('did-start-navigation', {}, 'file://', false, true)
  vi.advanceTimersByTime(2000)
  expect(h.stats().books[0].milliseconds).toBe(2000)
  h.start('a'); vi.advanceTimersByTime(1000)
  h.webContents.emit('render-process-gone'); vi.advanceTimersByTime(2000)
  expect(h.stats().books[0].milliseconds).toBe(3000)
  h.start('a'); vi.advanceTimersByTime(1000)
  h.win.emit('closed'); windows.splice(0)
  expect(getReadingStats(h.db).books[0].milliseconds).toBe(4000)
  expect(() => h.stats()).toThrow('阅读窗口无效')
  expect(powerMonitor.listenerCount('suspend')).toBe(0)
  expect(app.listenerCount('before-quit')).toBe(0)
})

it('系统闲置查询异常不会崩溃、误计后台时间或阻止已有记录保存，恢复后继续计时', () => {
  const h = setup(); h.start('a')
  vi.advanceTimersByTime(2000)
  mocks.idle.mockImplementation(() => { throw new Error('idle unavailable') })
  vi.advanceTimersByTime(18_000)
  expect(getReadingStats(h.db).books[0].milliseconds).toBe(3000)
  expect(h.webContents.send).toHaveBeenCalledWith('reading:error', '系统闲置状态暂时不可用，阅读计时已暂停，正在重试')
  expect(h.webContents.send).not.toHaveBeenLastCalledWith('reading:error', null)
  mocks.idle.mockReturnValue(0)
  vi.advanceTimersByTime(2000)
  expect(h.stats().books[0].milliseconds).toBe(4000)
})
