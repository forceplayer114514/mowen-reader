import { app, BrowserWindow, ipcMain, powerMonitor } from 'electron'
import type { Db } from './db'
import { getBook, markBookRead } from './db/books'
import { getReadingStats, saveReadingTime } from './db/reading-stats'
import { createReadingTimer } from './reading-timer'

const timers = new Map<number, ReturnType<typeof createReadingTimer>>()

export function registerReadingStats(database: () => Db): void {
  ipcMain.handle('reading:book', (event, bookId: unknown) => {
    const timer = timers.get(event.sender.id)
    if (!timer || event.senderFrame !== event.sender.mainFrame) throw new Error('阅读窗口无效')
    if (bookId !== null && (typeof bookId !== 'string' || bookId.length > 200 || !getBook(database(), bookId))) {
      throw new Error('阅读书籍无效')
    }
    timer.setBook(bookId as string | null)
    if (typeof bookId === 'string') markBookRead(database(), bookId)
  })
  ipcMain.handle('reading:stats', (event) => {
    if (!timers.has(event.sender.id) || event.senderFrame !== event.sender.mainFrame) throw new Error('阅读窗口无效')
    for (const timer of timers.values()) timer.flush()
    return getReadingStats(database())
  })
}

export function attachReadingStats(win: BrowserWindow, database: () => Db): void {
  const id = win.webContents.id
  const timer = createReadingTimer((bookId, entries) => saveReadingTime(database(), bookId, entries))
  timers.set(id, timer)
  let suspended = false
  let locked = false
  let ticks = 0
  let idleUnavailable = false
  function notify(error: string | null): void {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('reading:error', error)
  }
  function attempt(action: () => void): void {
    try {
      action()
      if (!idleUnavailable) notify(null)
    } catch {
      notify('阅读时长保存失败，正在重试；请暂时不要退出软件')
    }
  }
  function update(): void {
    const foreground = !suspended && !locked && win.isFocused() && win.isVisible() && !win.isMinimized()
    if (!foreground) { timer.setActive(false); return }
    try {
      timer.setActive(powerMonitor.getSystemIdleTime() < 300)
      if (idleUnavailable) { idleUnavailable = false; notify(null) }
    } catch {
      timer.setActive(false)
      if (!idleUnavailable) notify('系统闲置状态暂时不可用，阅读计时已暂停，正在重试')
      idleUnavailable = true
    }
  }
  function pause(): void { timer.setActive(false); attempt(timer.flush) }
  function suspend(): void { suspended = true; pause() }
  function resume(): void { suspended = false; update() }
  function lock(): void { locked = true; pause() }
  function unlock(): void { locked = false; update() }
  win.on('focus', update)
  win.on('blur', pause)
  win.on('minimize', pause)
  win.on('hide', pause)
  powerMonitor.on('suspend', suspend)
  powerMonitor.on('resume', resume)
  powerMonitor.on('lock-screen', lock)
  powerMonitor.on('unlock-screen', unlock)
  const interval = setInterval(() => {
    update()
    if (++ticks % 15 === 0) attempt(timer.flush)
  }, 1000)
  // 重载/渲染进程崩溃不能留下一个继续计时的旧阅读会话。
  function reset(): void { attempt(() => timer.setBook(null)) }
  win.webContents.on('render-process-gone', reset)
  win.webContents.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => { if (mainFrame) reset() })
  app.on('before-quit', pause)
  win.once('closed', () => {
    pause()
    clearInterval(interval)
    timers.delete(id)
    app.off('before-quit', pause)
    powerMonitor.off('suspend', suspend)
    powerMonitor.off('resume', resume)
    powerMonitor.off('lock-screen', lock)
    powerMonitor.off('unlock-screen', unlock)
  })
  update()
}
