import { createServer, type Server } from 'node:http'
import JSZip from 'jszip'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { buildFixtureEpub } from '../../scripts/make-fixture-epub'
import { closeAllApps, launch, type Harness } from './helpers'

let server: Server
let url: string
test.beforeAll(async () => {
  const bytes = Buffer.from(await buildFixtureEpub())
  const brokenZip = await JSZip.loadAsync(bytes)
  brokenZip.remove('OEBPS/content.opf')
  const brokenBytes = await brokenZip.generateAsync({ type: 'nodebuffer' })
  server = createServer((req, res) => {
    if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end('<h1>在线书库测试</h1><a href="/book.epub">下载 EPUB</a> <a href="/bad.epub">错误页面</a> <a href="/broken.epub">损坏电子书</a> <a href="/slow.epub">慢速下载</a> <a href="/book.pdf">PDF</a>')
      return
    }
    res.setHeader('Content-Disposition', `attachment; filename="${req.url?.slice(1)}"`)
    res.setHeader('Content-Type', 'application/epub+zip')
    if (req.url === '/bad.epub') { res.end('<html>Login required</html>'); return }
    if (req.url === '/book.pdf') { res.end('%PDF'); return }
    if (req.url === '/broken.epub') { res.end(brokenBytes); return }
    res.setHeader('Content-Length', bytes.length)
    if (req.url === '/slow.epub') {
      res.write(bytes.subarray(0, 1024))
      const timer = setTimeout(() => res.end(bytes.subarray(1024)), 3000)
      res.on('close', () => clearTimeout(timer))
    } else res.end(bytes)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`
})
test.afterEach(closeAllApps)
test.afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())) })

async function site(h: Harness): Promise<Page> {
  await h.page.getByTestId('download-books').click()
  await expect(h.page.getByTestId('online-library')).toBeVisible()
  await expect.poll(() => h.app.context().pages().filter(page => page.url() === url).length).toBe(1)
  const page = h.app.context().pages().find(page => page.url() === url)!
  await page.getByRole('heading', { name: '在线书库测试' }).waitFor()
  return page
}

test('native website download auto-imports, deduplicates, persists and stays isolated', async () => {
  const h = await launch(undefined, { READER_ONLINE_URL: url })
  const remote = await site(h)
  expect(await remote.evaluate(() => ({ api: typeof (window as any).api, node: typeof (window as any).require })))
    .toEqual({ api: 'undefined', node: 'undefined' })
  await h.app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => { throw new Error('No file picker allowed') } })
  await remote.getByRole('link', { name: '下载 EPUB' }).click()
  await expect(h.page.getByTestId('download-task')).toContainText('已加入默认书库')
  await remote.getByRole('link', { name: '下载 EPUB' }).click()
  await expect(h.page.getByTestId('download-task').last()).toContainText('未重复添加')
  await h.page.getByRole('button', { name: '← 书架', exact: true }).click()
  await expect(h.page.getByTestId('book-card')).toHaveCount(1)
  await expect(h.page.getByTestId('book-card')).toContainText('测试之书')
  expect(readdirSync(join(h.userData, 'books')).filter(name => name.endsWith('.epub'))).toHaveLength(1)
  expect(readdirSync(join(h.userData, 'downloads'))).toHaveLength(0)
  await h.page.getByTestId('book-card').click()
  await expect(h.page.getByTestId('reader-page')).toBeVisible()
  await h.app.close()
  const restarted = await launch(h.userData, { READER_ONLINE_URL: url })
  await expect(restarted.page.getByTestId('book-card')).toHaveCount(1)
})

test('manual import, invalid files and cancellation never silently pollute the library', async () => {
  const h = await launch(undefined, { READER_ONLINE_URL: url })
  const remote = await site(h)
  await h.page.getByLabel('下载后自动入库').uncheck()
  await remote.getByRole('link', { name: '下载 EPUB' }).click()
  await expect(h.page.getByTestId('download-task')).toContainText('待入库')
  expect(await h.page.evaluate(() => window.api.listBooks())).toHaveLength(0)
  await h.page.getByRole('button', { name: '导入', exact: true }).click()
  await expect(h.page.getByTestId('download-task')).toContainText('已入库')
  await remote.getByRole('link', { name: '错误页面' }).click()
  await expect(h.page.getByTestId('download-task').last()).toContainText('不是 EPUB')
  await remote.getByRole('link', { name: 'PDF', exact: true }).click()
  await expect(h.page.getByTestId('download-task').last()).toContainText('仅支持')
  await remote.getByRole('link', { name: '慢速下载' }).click()
  await expect(h.page.getByTestId('download-task').last()).toContainText('下载中')
  await h.page.getByRole('button', { name: '取消 slow.epub', exact: true }).click()
  await h.page.getByRole('button', { name: '← 书架', exact: true }).click()
  await expect(h.page.getByTestId('book-card')).toHaveCount(1)
  await expect.poll(() => readdirSync(join(h.userData, 'downloads')).filter(name => name.endsWith('.epub')).length).toBe(0)
})

test('downloads finish after returning to the shelf, and native content follows resize bounds', async () => {
  const h = await launch(undefined, { READER_ONLINE_URL: url })
  const remote = await site(h)
  await remote.getByRole('link', { name: '慢速下载' }).click()
  await h.page.getByRole('button', { name: '← 书架', exact: true }).click()
  await expect(h.page.getByTestId('book-card')).toHaveCount(1)
  await h.page.getByTestId('download-books').click()
  const host = await h.page.getByTestId('online-site').boundingBox()
  const bounds = await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.at(-1)!.getBounds())
  expect(bounds.x).toBe(Math.round(host!.x))
  expect(bounds.height).toBe(Math.round(host!.height))
})

test('completed manual downloads and auto-import preference survive restart', async () => {
  const h = await launch(undefined, { READER_ONLINE_URL: url })
  const remote = await site(h)
  await h.page.getByLabel('下载后自动入库').uncheck()
  await remote.getByRole('link', { name: '下载 EPUB' }).click()
  await expect(h.page.getByTestId('download-task')).toContainText('待入库')
  await h.app.close()
  const restarted = await launch(h.userData, { READER_ONLINE_URL: url })
  await restarted.page.getByTestId('open-downloads').click()
  await expect(restarted.page.getByLabel('下载后自动入库')).not.toBeChecked()
  await expect(restarted.page.getByTestId('download-task')).toContainText('待入库')
  expect(await restarted.page.evaluate(() => window.api.listBooks())).toHaveLength(0)
  await restarted.page.getByLabel('下载后自动入库').check()
  await expect(restarted.page.getByTestId('book-card')).toHaveCount(1)
})

test('metadata failure retains the download for retry without orphan library files', async () => {
  const h = await launch(undefined, { READER_ONLINE_URL: url })
  const remote = await site(h)
  await remote.getByRole('link', { name: '损坏电子书' }).click()
  await expect(h.page.getByTestId('download-task')).toContainText('未完成')
  await expect(h.page.getByRole('button', { name: '重试入库' })).toBeVisible()
  expect(await h.page.evaluate(() => window.api.listBooks())).toHaveLength(0)
  const books = join(h.userData, 'books')
  expect(existsSync(books) ? readdirSync(books).filter(name => name.endsWith('.epub')) : []).toHaveLength(0)
  expect(readdirSync(join(h.userData, 'downloads')).filter(name => name.endsWith('.epub'))).toHaveLength(1)
  await h.page.getByRole('button', { name: '移除 broken.epub' }).click()
  expect(readdirSync(join(h.userData, 'downloads'))).toHaveLength(0)
})

test('a claimed import recovers after app-page reload and rejects website IPC senders', async () => {
  const h = await launch(undefined, { READER_ONLINE_URL: url })
  const remote = await site(h)
  await h.page.getByLabel('下载后自动入库').uncheck()
  await remote.getByRole('link', { name: '下载 EPUB' }).click()
  await expect(h.page.getByTestId('download-task')).toContainText('待入库')
  await h.page.evaluate(async () => {
    const task = (await window.api.onlineSnapshot()).tasks[0]
    await window.api.prepareDownload(task.id)
  })
  await expect(h.page.getByTestId('download-task')).toContainText('入库中')
  await h.page.reload()
  await h.page.getByTestId('open-downloads').click()
  await expect(h.page.getByTestId('download-task')).toContainText('页面已重新加载')
  await h.page.getByRole('button', { name: '重试入库' }).click()
  await expect(h.page.getByTestId('book-card')).toHaveCount(1)
  const denied = await h.app.evaluate(async ({ ipcMain, webContents }, home) => {
    const handler = (ipcMain as unknown as { _invokeHandlers: Map<string, Function> })._invokeHandlers.get('online:snapshot')!
    const site = webContents.getAllWebContents().find(contents => contents.getURL() === home)!
    try { await handler({ sender: site, senderFrame: site.mainFrame }); return false }
    catch { return true }
  }, url)
  expect(denied).toBe(true)
})

test('pending files and rejected-download history are bounded without losing manual downloads', async () => {
  const h = await launch(undefined, { READER_ONLINE_URL: url })
  const remote = await site(h)
  await h.page.getByLabel('下载后自动入库').uncheck()
  for (let i = 0; i < 5; i++) {
    await remote.getByRole('link', { name: '下载 EPUB' }).click()
    await expect.poll(async () => (await h.page.evaluate(() => window.api.onlineSnapshot())).tasks.filter(task => task.status === 'ready').length).toBe(i + 1)
  }
  await remote.getByRole('link', { name: '下载 EPUB' }).click()
  await expect(h.page.getByTestId('download-task').last()).toContainText('最多保留 5 个')
  for (let i = 0; i < 24; i++) await remote.getByRole('link', { name: 'PDF', exact: true }).click()
  await expect.poll(async () => (await h.page.evaluate(() => window.api.onlineSnapshot())).tasks.length).toBe(20)
  expect((await h.page.evaluate(() => window.api.onlineSnapshot())).tasks.filter(task => task.status === 'ready')).toHaveLength(5)
  expect(readdirSync(join(h.userData, 'downloads')).filter(name => name.endsWith('.epub'))).toHaveLength(5)
})

test('a renderer reload cannot interrupt an already-committing main-process import', async () => {
  const h = await launch(undefined, { READER_ONLINE_URL: url })
  const remote = await site(h)
  await h.page.getByLabel('下载后自动入库').uncheck()
  await remote.getByRole('link', { name: '下载 EPUB' }).click()
  await expect(h.page.getByTestId('download-task')).toContainText('待入库')
  await h.app.evaluate(async () => {
    const fs = process.getBuiltinModule('node:fs/promises')
    const module = process.getBuiltinModule('node:module')
    const copy = fs.copyFile
    fs.copyFile = async (...args) => {
      Object.assign(globalThis, { copyWaiting: true })
      await new Promise<void>(resolve => Object.assign(globalThis, { releaseCopy: resolve }))
      return copy(...args)
    }
    module.syncBuiltinESMExports()
  })
  await h.page.evaluate(async () => {
    const task = (await window.api.onlineSnapshot()).tasks[0]
    await window.api.prepareDownload(task.id)
    void window.api.finishDownload(task.id, { title: '测试之书', author: null, coverBytes: null }).catch(() => {})
  })
  await expect.poll(() => h.app.evaluate(() => (globalThis as any).copyWaiting)).toBe(true)
  await h.page.reload()
  await h.page.getByTestId('open-downloads').click()
  await expect(h.page.getByTestId('download-task')).toContainText('入库中')
  await h.app.evaluate(() => (globalThis as any).releaseCopy())
  await expect(h.page.getByTestId('book-card')).toHaveCount(1)
  await expect(h.page.getByTestId('download-task')).toContainText('已加入默认书库')
})

test('closing the tray does not cancel a download, returning to the shelf hides it, and records can be reopened', async () => {
  const h = await launch(undefined, { READER_ONLINE_URL: url })
  const remote = await site(h)
  await remote.getByRole('link', { name: '慢速下载' }).click()
  await expect(h.page.getByTestId('download-task')).toContainText('下载中')
  await h.page.getByRole('button', { name: '关闭下载面板' }).click()
  await expect(h.page.getByTestId('download-tray')).toHaveCount(0)
  await h.page.getByTestId('open-downloads').click()
  await expect(h.page.getByTestId('download-tray')).toBeVisible()
  await h.page.getByRole('button', { name: '← 书架', exact: true }).click()
  await expect(h.page.getByTestId('download-tray')).toHaveCount(0)
  await expect(h.page.getByTestId('book-card')).toHaveCount(1)
  await expect(h.page.getByTestId('download-tray')).toHaveCount(0)
  await h.page.getByTestId('open-downloads').click()
  await expect(h.page.getByTestId('download-task')).toContainText('已加入默认书库')
  await h.page.getByRole('button', { name: '查看书架', exact: true }).click()
  await expect(h.page.getByTestId('download-tray')).toHaveCount(0)
  await expect(h.page.getByTestId('book-card')).toHaveCount(1)
})
