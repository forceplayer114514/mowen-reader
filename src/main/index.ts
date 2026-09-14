import { join } from 'node:path'
import { app, BrowserWindow, safeStorage } from 'electron'
import { abortAllChats, registerIpc } from './ipc'
import { initDataDir } from './paths'
import { initSecrets } from './secrets'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'AI 阅读器',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  if (!process.env.READER_E2E) win.once('ready-to-show', () => win.show())

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

void app.whenReady().then(() => {
  if (!process.env.READER_USER_DATA) {
    initDataDir(app.getPath('userData'))
  }
  initSecrets(safeStorage)
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// 应用真正要退出时(不只是最后一个窗口被关掉——macOS 上关窗不等于退出应用,
// 停在 Dock 里的进程仍可能在继续一个用户已经看不到界面的流式请求)才中止
// 所有还在跑的模型请求。选 before-quit 而不是 window-all-closed:后者在
// macOS 上触发时应用并不会退出,过早中止会打断一个用户可能只是切到别的
// 窗口、稍后还会回来看结果的请求;before-quit 只在进程确实要终止时触发,
// 这时继续跑的请求已经没有意义——它的 fetch 会在进程退出时被操作系统
// 直接杀掉,不中止的话就是悄悄泄漏一个连接,而不是体面地收尾。
app.on('before-quit', () => {
  abortAllChats()
})
