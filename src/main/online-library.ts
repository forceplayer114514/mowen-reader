import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync } from 'node:fs'
import { lstat, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { BrowserWindow, DownloadItem, ipcMain, shell, WebContentsView } from 'electron'
import type { DownloadMetadata, DownloadTask, OnlineAction, OnlineBounds, OnlineSnapshot } from '../shared/types'
import { copyEpubIntoLibrary, discardStagedFile } from './books/import'
import { MAX_DOWNLOAD_BYTES, validateDownloadedEpub } from './books/validate-download'
import { listBooks } from './db/books'
import { getSetting, setSetting } from './db/settings'
import { database, finishBookImport } from './ipc'
import { resolveDataDir } from './paths'

const HOME = 'https://z-library.bz/'
const UUID = /^[0-9a-f-]{36}$/
type Job = DownloadTask & { path: string; hash?: string; item?: DownloadItem; committing?: boolean }
// ponytail: one writer and one validator for this desktop app; per-library queues if multi-window throughput matters.
let imports = Promise.resolve()
let validations = Promise.resolve()

export function attachOnlineLibrary(win: BrowserWindow): void {
  const root = join(resolveDataDir(), 'downloads')
  mkdirSync(root, { recursive: true })
  const jobs = new Map<string, Job>()
  let view: WebContentsView | null = null
  let attached = false
  let closed = false
  let autoImport = getSetting(database(), 'onlineAutoImport') !== 'false'
  let error: string | null = null
  let navigationDownloadUrls: string[] = []
  let failedDownloadNavigation: string | null = null
  const fixture = process.env.READER_E2E === '1' ? process.env.READER_ONLINE_URL : undefined
  const home = fixture || HOME
  let currentOrigin = new URL(home).origin
  let navigationOrigin: { origin: string } | null = null
  // Exact origins, not substring/suffix matches. A site cannot grant trust to its own ads.
  const allowedOrigins = new Set([new URL(home).origin])
  let blockedNavigation: { url: string; origin: string; reason: 'popup' | 'external'; referrer?: Electron.Referrer } | null = null
  function safeUrl(value: string): boolean {
    try {
      const url = new URL(value)
      return !url.username && !url.password && (url.protocol === 'https:' ||
        (!!fixture && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))
    } catch { return false }
  }
  function trustedUrl(value: string): boolean {
    if (!safeUrl(value)) return false
    const origin = new URL(value).origin
    return origin === currentOrigin || origin === navigationOrigin?.origin || allowedOrigins.has(origin)
  }
  function blockNavigation(url: string, reason: 'popup' | 'external', referrer?: Electron.Referrer): void {
    if (!safeUrl(url)) {
      blockedNavigation = null
      error = '已拦截不安全的网站跳转或弹窗'
      publish(); return
    }
    blockedNavigation = { url, origin: new URL(url).origin, reason, referrer }
    publish()
  }
  async function loadPage(url: string, httpReferrer?: Electron.Referrer): Promise<void> {
    const navigation = { origin: new URL(url).origin }
    navigationOrigin = navigation
    const previousBlock = blockedNavigation
    navigationDownloadUrls = []
    failedDownloadNavigation = null
    try { await ensureView().webContents.loadURL(url, { httpReferrer }) }
    catch (cause) {
      const code = (cause as { code?: string }).code
      // A download, replacement navigation or our redirect guard cancels the page load normally.
      if (code === 'ERR_ABORTED') return
      if (blockedNavigation && blockedNavigation !== previousBlock && ['ERR_BLOCKED_BY_CLIENT', 'ERR_FAILED'].includes(code || '')) return
      // Electron 44 reports attachment navigation as ERR_FAILED even when will-download succeeds.
      if (code === 'ERR_FAILED' && navigationDownloadUrls.includes(url)) return
      if (!error) {
        error = `网站连接失败：${code || '请稍后重试'}`
        if (code === 'ERR_FAILED') failedDownloadNavigation = url
      }
      publish()
    } finally {
      if (navigationOrigin === navigation) navigationOrigin = null
    }
  }
  function snapshot(): OnlineSnapshot {
    return {
      url: view?.webContents.getURL() || home,
      loading: view?.webContents.isLoading() || false,
      canGoBack: view?.webContents.navigationHistory.canGoBack() || false,
      error, autoImport,
      blockedNavigation: blockedNavigation ? { origin: blockedNavigation.origin, reason: blockedNavigation.reason } : null,
      tasks: [...jobs.values()].map(({ path: _path, hash: _hash, item: _item, committing: _committing, ...task }) => task)
    }
  }
  function publish(): void {
    // Bound terminal history without deleting any completed file awaiting import.
    for (const [id, job] of jobs) {
      if (jobs.size <= 20) break
      if (['imported', 'cancelled'].includes(job.status) || (job.status === 'error' && job.canImport === false)) jobs.delete(id)
    }
    if (!closed && !win.webContents.isDestroyed()) win.webContents.send('online:changed', snapshot())
  }
  const cleanup = (job: Job): Promise<void> => rm(job.path, { force: true }).catch(() => {})
  function validate(job: Job): Promise<void> {
    job.status = 'validating'; publish()
    const next = validations.then(async () => {
      try {
        const stat = await lstat(job.path)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_DOWNLOAD_BYTES) throw new Error('下载文件无效或超过 64 MB')
        const bytes = await readFile(job.path)
        await validateDownloadedEpub(bytes)
        job.hash = createHash('sha256').update(bytes).digest('hex')
        job.status = 'ready'; job.canImport = true; job.message = undefined
      } catch (cause) {
        job.status = 'error'; job.canImport = false
        job.message = cause instanceof Error ? cause.message : '文件校验失败'
        await cleanup(job)
      }
      publish()
    })
    validations = next.catch(() => {})
    return next
  }
  function ensureView(): WebContentsView {
    if (view) return view
    view = new WebContentsView({ webPreferences: {
      partition: 'persist:online-library', sandbox: true, contextIsolation: true, nodeIntegration: false,
      preload: join(import.meta.dirname, '../preload/online-site.cjs')
    } })
    const contents = view.webContents
    const siteSession = contents.session
    siteSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    siteSession.setPermissionCheckHandler(() => false)
    contents.on('will-navigate', event => {
      if (!trustedUrl(event.url)) { event.preventDefault(); blockNavigation(event.url, 'external') }
    })
    contents.on('will-redirect', event => {
      if (event.isMainFrame && !trustedUrl(event.url)) { event.preventDefault(); blockNavigation(event.url, 'external') }
    })
    contents.setWindowOpenHandler(({ url, referrer }) => {
      // Actual clicked anchors use the isolated preload; unsolicited popups never replace the page.
      blockNavigation(url, 'popup', referrer)
      return { action: 'deny' }
    })
    const openLink = (event: Electron.IpcMainEvent, data: unknown): void => {
      if (event.sender !== contents || event.senderFrame !== contents.mainFrame || !attached) return
      const request = data as { url?: unknown; download?: unknown } | null
      if (!request || typeof request.url !== 'string' || request.url.length > 8192 || typeof request.download !== 'boolean') return
      if (!safeUrl(request.url)) { blockNavigation(request.url, 'external'); return }
      blockedNavigation = null; error = null; publish()
      if (request.download) contents.downloadURL(request.url)
      else void loadPage(request.url, { url: contents.getURL(), policy: 'strict-origin-when-cross-origin' })
    }
    ipcMain.on('online:open-link', openLink)
    // loadURL/history/service-worker redirects may bypass will-navigate. Stop them before HTTP.
    // Only this isolated online-library partition is affected; CDN/captcha subresources still work.
    siteSession.webRequest.onBeforeRequest((details, callback) => {
      const cancel = details.resourceType === 'mainFrame' && !trustedUrl(details.url)
      callback({ cancel })
      if (cancel) blockNavigation(details.url, 'external')
    })
    contents.on('did-start-loading', () => { error = null; publish() })
    contents.on('did-stop-loading', publish)
    contents.on('did-navigate', (_event, url, status) => {
      currentOrigin = new URL(url).origin
      navigationOrigin = null
      if (status >= 400) error = status === 522
        ? 'HTTP 522：网站服务器连接超时，请稍后重试；这不是应用拦截造成的。'
        : `网站返回 HTTP ${status}，请按网页提示处理或稍后重试。`
      publish()
    })
    contents.on('did-navigate-in-page', publish)
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (isMainFrame && code !== -3 && !(code === -20 && !trustedUrl(url))) {
        error = `网站加载失败：${description}`; publish()
      }
    })
    const download = (event: Electron.Event, item: DownloadItem, sender: Electron.WebContents): void => {
      if (sender !== contents) return
      navigationDownloadUrls = item.getURLChain()
      // will-download can arrive after loadURL rejects. Clear only that exact navigation's artefact.
      if (failedDownloadNavigation && navigationDownloadUrls.includes(failedDownloadNavigation) && error === '网站连接失败：ERR_FAILED') {
        failedDownloadNavigation = null; error = null
      }
      const name = item.getFilename().replace(/[\x00-\x1f]/g, '').slice(0, 180)
      const pending = [...jobs.values()].filter(j => !['imported', 'cancelled'].includes(j.status) && j.canImport !== false).length
      if (!/\.epub$/i.test(name) || !item.getURLChain().every(safeUrl) || item.getTotalBytes() > MAX_DOWNLOAD_BYTES || pending >= 5) {
        event.preventDefault()
        const id = randomUUID()
        jobs.set(id, { id, name, path: join(root, `${id}.epub`), status: 'error', received: 0, total: 0,
          canImport: false, message: pending >= 5 ? '最多保留 5 个待处理下载，请先入库或移除' : '仅支持 64 MB 以内的 EPUB，请在网站选择 EPUB 格式' })
        publish(); return
      }
      const id = randomUUID()
      const job: Job = { id, name, path: join(root, `${id}.epub`), status: 'downloading', received: 0, total: item.getTotalBytes(), item }
      jobs.set(id, job)
      item.setSavePath(job.path)
      item.on('updated', () => {
        job.received = item.getReceivedBytes(); job.total = item.getTotalBytes()
        if (job.received > MAX_DOWNLOAD_BYTES) { job.message = '电子书超过 64 MB 限制'; item.cancel() }
        publish()
      })
      item.once('done', (_event, state) => {
        job.item = undefined
        if (state === 'completed') void validate(job)
        else {
          job.status = state === 'cancelled' && !job.message ? 'cancelled' : 'error'
          job.canImport = false; job.message ||= state === 'cancelled' ? '已取消' : '下载中断，请在网站重新下载'
          void cleanup(job); publish()
        }
      })
      publish()
    }
    siteSession.on('will-download', download)
    win.once('closed', () => {
      ipcMain.removeListener('online:open-link', openLink)
      siteSession.removeListener('will-download', download)
      siteSession.webRequest.onBeforeRequest(null)
    })
    void contents.loadURL(home).catch(() => {})
    return view
  }
  const channels: string[] = []
  function handle(name: string, fn: (...args: any[]) => unknown): void {
    const channel = `online:${name}`
    channels.push(channel)
    ipcMain.handle(channel, (event, ...args) => {
      if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('不允许的网站请求')
      return fn(...args)
    })
  }
  function getJob(id: string): Job {
    const job = jobs.get(id)
    if (!job) throw new Error('下载不存在')
    return job
  }
  handle('snapshot', snapshot)
  handle('bounds', (bounds: OnlineBounds | null) => {
    if (!bounds) {
      if (attached && view) win.contentView.removeChildView(view)
      attached = false; return
    }
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) throw new Error('无效的网站区域')
    const [width, height] = win.getContentSize()
    const x = Math.max(0, Math.min(width, Math.round(bounds.x)))
    const y = Math.max(0, Math.min(height, Math.round(bounds.y)))
    const web = ensureView()
    web.setBounds({ x, y, width: Math.max(0, Math.min(width - x, Math.round(bounds.width))), height: Math.max(0, Math.min(height - y, Math.round(bounds.height))) })
    if (!attached) win.contentView.addChildView(web)
    attached = true
  })
  handle('action', async (action: OnlineAction, approvedOrigin?: string) => {
    if (action === 'dismiss-navigation') { blockedNavigation = null; publish(); return }
    if (action === 'allow-site') {
      const target = blockedNavigation
      if (!target || target.origin !== approvedOrigin || !safeUrl(target.url)) throw new Error('目标站点已变化，请重新确认')
      allowedOrigins.add(target.origin)
      blockedNavigation = null; error = null; publish()
      await loadPage(target.url, target.referrer)
      return
    }
    const contents = ensureView().webContents
    if (action === 'back' && contents.navigationHistory.canGoBack()) {
      const history = contents.navigationHistory
      const target = history.getEntryAtIndex(history.getActiveIndex() - 1)
      if (target && safeUrl(target.url)) {
        const navigation = { origin: new URL(target.url).origin }
        navigationOrigin = navigation
        contents.once('did-stop-loading', () => { if (navigationOrigin === navigation) navigationOrigin = null })
        history.goBack()
      }
    }
    else if (action === 'refresh') contents.reload()
    else if (action === 'home') {
      blockedNavigation = null; publish(); await loadPage(home)
    }
    else if (action === 'external') {
      const url = contents.getURL() || HOME
      if (!trustedUrl(url)) throw new Error('不允许打开这个地址')
      await shell.openExternal(url)
    }
  })
  handle('auto', (value: boolean) => {
    if (typeof value !== 'boolean') throw new Error('无效的下载设置')
    setSetting(database(), 'onlineAutoImport', String(value))
    autoImport = value; publish()
  })
  handle('remove', async (id: string) => {
    const job = getJob(id)
    if (['importing', 'validating'].includes(job.status)) throw new Error('请等待入库或校验完成')
    // Revoke the claim before asynchronous cleanup, so auto-import cannot race a removal.
    job.status = 'cancelled'; job.canImport = false
    job.item?.cancel()
    publish()
    await rm(job.path, { force: true }); jobs.delete(id); publish()
  })
  handle('prepare', async (id: string) => {
    const job = getJob(id)
    if (!job.canImport || !['ready', 'error'].includes(job.status)) return null
    job.status = 'importing'; job.message = undefined; publish()
    try {
      const bytes = await readFile(job.path)
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    } catch (cause) { job.status = 'error'; job.canImport = false; job.message = '无法读取下载文件，请重新下载'; publish(); throw cause }
  })
  handle('fail', (id: string, message: string) => {
    const job = getJob(id)
    if (job.status !== 'importing' || job.committing) return
    job.status = 'error'; job.message = String(message).slice(0, 250); publish()
  })
  handle('finish', (id: string, meta: DownloadMetadata) => {
    const job = getJob(id)
    if (job.status !== 'importing' || !job.hash) throw new Error('下载没有准备好')
    if (typeof meta.title !== 'string' || meta.title.length > 1000 ||
      (meta.author !== null && (typeof meta.author !== 'string' || meta.author.length > 1000)) ||
      (meta.coverBytes !== null && (!(meta.coverBytes instanceof ArrayBuffer) || meta.coverBytes.byteLength > 5 * 1024 * 1024))) throw new Error('电子书元数据无效或过大')
    if (job.committing) throw new Error('正在保存电子书')
    job.committing = true
    const next = imports.then(async () => {
      let staged: Awaited<ReturnType<typeof copyEpubIntoLibrary>> | undefined
      try {
        const sourcePath = `online:sha256:${job.hash}`
        const existing = listBooks(database()).find(book => book.sourcePath === sourcePath)
        if (existing) { job.bookId = existing.id; job.message = '这本书已在书库中，未重复添加' }
        else {
          staged = await copyEpubIntoLibrary(job.path)
          const stat = await lstat(staged.filePath)
          if (!stat.isFile() || stat.size > MAX_DOWNLOAD_BYTES || createHash('sha256').update(await readFile(staged.filePath)).digest('hex') !== job.hash) {
            throw new Error('下载文件已改变，请重新下载')
          }
          const book = await finishBookImport({ ...meta, id: staged.id, sourcePath, title: meta.title || job.name.replace(/\.epub$/i, '') })
          job.bookId = book.id; job.message = '已加入默认书库'
        }
        job.status = 'imported'; job.canImport = false
        await cleanup(job); publish()
      } catch (cause) {
        if (staged) await discardStagedFile(staged.id).catch(() => {})
        job.status = 'error'; job.message = '入库失败，下载文件已保留，可重试'; publish(); throw cause
      } finally { job.committing = false }
    })
    imports = next.catch(() => {})
    return next
  })
  const resetClaims = (): void => {
    for (const job of jobs.values()) {
      if (job.status === 'importing' && !job.committing) {
        job.status = 'error'; job.message = '页面已重新加载，下载文件已保留，可重试入库'
      }
    }
    publish()
  }
  win.webContents.on('did-start-navigation', details => {
    if (details.isMainFrame && !details.isSameDocument) resetClaims()
  })
  win.webContents.on('render-process-gone', resetClaims)
  // Recover completed files after restart; interrupted .crdownload files are never treated as books.
  for (const name of readdirSync(root)) {
    const id = name.replace(/\.epub$/, '')
    if (!name.endsWith('.epub') || !UUID.test(id)) continue
    const job: Job = { id, name: '上次下载的电子书.epub', path: join(root, name), status: 'validating', received: 0, total: 0 }
    jobs.set(id, job); void validate(job)
  }
  win.once('closed', () => {
    closed = true
    for (const channel of channels) ipcMain.removeHandler(channel)
    for (const job of jobs.values()) job.item?.cancel()
    if (view && !view.webContents.isDestroyed()) view.webContents.close()
  })
}
