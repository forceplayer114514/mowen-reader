import { createServer, type Server } from 'node:http'
import { expect, test, type Page } from '@playwright/test'
import { buildFixtureEpub } from '../../scripts/make-fixture-epub'
import { closeAllApps, launch, type Harness } from './helpers'

let library: Server
let other: Server
let home: string
let outside: string
let outsideRequests = 0
let outsidePaths: string[] = []

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}
test.beforeAll(async () => {
  const book = Buffer.from(await buildFixtureEpub())
  other = createServer((req, res) => {
    outsideRequests++
    outsidePaths.push(req.url || '')
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    if (req.url === '/book.epub') {
      res.setHeader('Content-Disposition', 'attachment; filename="book.epub"')
      res.end(book); return
    }
    if (req.url === '/unavailable') { res.writeHead(522); res.end('<h1>Connection timed out</h1>'); return }
    res.end('<h1>另一个站点</h1>')
  })
  outside = await listen(other)
  library = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: `${outside}/shopping` }); res.end(); return }
    if (req.url === '/frame') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(`<a href="${outside}/shopping" target="_top">劫持父页面</a>`); return
    }
    if (req.url === '/book.epub') {
      res.setHeader('Content-Disposition', 'attachment; filename="book.epub"')
      res.end(book); return
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(`<h1>在线书库</h1>
      <button onclick="window.open('${outside}/shopping', '_blank')">弹出购物广告</button>
      <a href="${outside}/shopping">站外跳转</a>
      <a href="/redirect">服务端广告跳转</a>
      <a href="/redirect" target="_blank">伪装站内弹窗</a>
      <a href="/book.epub" onclick="window.open('${outside}/shopping', '_blank')">下载 EPUB</a>
      <a href="${outside}/book.epub">跨站 EPUB 下载</a>
      <a href="${outside}/unavailable">超时书籍链接</a>
      <a data-book-cover href="${outside}/book/detail" target="_blank" onclick="window.open('${outside}/shopping', '_blank')">
        <img alt="图书封面" width="80" height="100" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" />
      </a>
      <a href="/book.epub" download>下载属性 EPUB</a>
      <a href="#menu" onclick="document.querySelector('h1').textContent='菜单已展开'">展开菜单</a>
      <a href="/chapter" target="_blank">正常站内新窗口</a>`)
  })
  home = `${await listen(library)}/`
})
test.beforeEach(() => { outsideRequests = 0; outsidePaths = [] })
test.afterEach(closeAllApps)
test.afterAll(async () => {
  await Promise.all([library, other].map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

async function site(h: Harness): Promise<Page> {
  await h.page.getByTestId('download-books').click()
  await expect.poll(() => h.app.context().pages().some(page => page.url() === home)).toBe(true)
  const page = h.app.context().pages().find(page => page.url() === home)!
  await expect(page.getByRole('heading', { name: '在线书库' })).toBeVisible()
  return page
}

test('advertising popups are denied without taking over the page or interrupting EPUB downloads', async () => {
  const h = await launch(undefined, { READER_ONLINE_URL: home })
  const remote = await site(h)
  await remote.getByRole('button', { name: '弹出购物广告' }).click()
  await expect(h.page.getByTestId('blocked-navigation')).toBeVisible()
  expect(remote.url()).toBe(home)
  expect(outsideRequests).toBe(0)
  expect(h.app.context().pages()).toHaveLength(2)
  await h.page.getByRole('button', { name: '留在当前页面' }).click()
  await remote.getByRole('link', { name: '下载 EPUB' }).click()
  await expect(h.page.getByTestId('download-task')).toContainText('已加入默认书库')
  expect(remote.url()).toBe(home)
  expect(outsideRequests).toBe(0)
})

for (const trigger of ['script', 'HTTP redirect'] as const) {
  test(`${trigger} navigation cannot reach an unapproved shopping origin`, async () => {
    const h = await launch(undefined, { READER_ONLINE_URL: home })
    const remote = await site(h)
    // Electron cancels outside Chromium; Playwright must not wait for a nonexistent commit.
    if (trigger === 'script') await remote.evaluate(destination => { window.location.href = destination }, `${outside}/shopping`)
    else await remote.getByRole('link', { name: '服务端广告跳转', exact: true }).click({ noWaitAfter: true })
    await expect(h.page.getByTestId('blocked-navigation')).toBeVisible()
    expect(remote.url()).toBe(home)
    expect(outsideRequests).toBe(0)
  })
}

test('an embedded frame cannot hijack the top page', async () => {
  const h = await launch(undefined, { READER_ONLINE_URL: home })
  const remote = await site(h)
  await remote.evaluate(() => {
    const frame = document.createElement('iframe'); frame.src = '/frame'; document.body.append(frame)
  })
  await remote.frameLocator('iframe').getByRole('link', { name: '劫持父页面' }).click({ noWaitAfter: true })
  await expect(h.page.getByTestId('blocked-navigation')).toBeVisible()
  expect(remote.url()).toBe(home)
  expect(outsideRequests).toBe(0)
})

test('subframe redirects remain available for embedded login and captcha resources', async () => {
  const h = await launch(undefined, { READER_ONLINE_URL: home })
  const remote = await site(h)
  await remote.evaluate(() => {
    const frame = document.createElement('iframe'); frame.src = '/redirect'; document.body.append(frame)
  })
  await expect(remote.frameLocator('iframe').getByRole('heading', { name: '另一个站点' })).toBeVisible()
  expect(outsideRequests).toBeGreaterThan(0)
  expect(remote.url()).toBe(home)
  await expect(h.page.getByTestId('blocked-navigation')).toHaveCount(0)
})

test('native network guard also blocks programmatic loadURL, and only the displayed origin may be approved', async () => {
  const h = await launch(undefined, { READER_ONLINE_URL: home })
  const remote = await site(h)
  await h.app.evaluate(async ({ webContents }, destination) => {
    const site = webContents.getAllWebContents().find(contents => contents.getURL() === destination.home)!
    await site.loadURL(destination.outside).catch(() => {})
  }, { home, outside: `${outside}/shopping` })
  await expect(h.page.getByTestId('blocked-navigation')).toBeVisible()
  expect(outsideRequests).toBe(0)
  await expect(h.page.evaluate(() => window.api.onlineAction('allow-site', 'https://wrong.example'))).rejects.toThrow()
  expect(outsideRequests).toBe(0)
  await h.page.getByRole('button', { name: '允许并打开（本次）' }).click()
  await expect(remote.getByRole('heading', { name: '另一个站点' })).toBeVisible()
  expect(outsideRequests).toBeGreaterThan(0)
})

test('trusted book links open inline without creating a window or requiring another approval', async () => {
  const h = await launch(undefined, { READER_ONLINE_URL: home })
  const remote = await site(h)
  await remote.getByRole('link', { name: '正常站内新窗口' }).click()
  await expect.poll(() => remote.url()).toBe(new URL('/chapter', home).href)
  await expect(h.page.getByTestId('blocked-navigation')).toHaveCount(0)
  expect(h.app.context().pages()).toHaveLength(2)
})

test('a trusted popup cannot bypass the guard by redirecting to a shopping site', async () => {
  const h = await launch(undefined, { READER_ONLINE_URL: home })
  const remote = await site(h)
  await remote.getByRole('link', { name: '伪装站内弹窗' }).click({ noWaitAfter: true })
  await expect(h.page.getByTestId('blocked-navigation')).toBeVisible()
  expect(remote.url()).toBe(home)
  expect(outsideRequests).toBe(0)
  await expect(h.page.locator('.online__error')).toHaveCount(0)
})

test('a clicked cross-site book download works without extra approval or a false navigation failure', async () => {
  const h = await launch(undefined, { READER_ONLINE_URL: home })
  const remote = await site(h)
  await remote.getByRole('link', { name: '跨站 EPUB 下载' }).click({ noWaitAfter: true })
  await expect(h.page.getByTestId('download-task')).toContainText('已加入默认书库')
  await expect(h.page.getByTestId('blocked-navigation')).toHaveCount(0)
  await expect(h.page.locator('.online__error')).toHaveCount(0)
})

test('a 522 book page identifies the website server timeout and is not reported as an application error', async () => {
  const h = await launch(undefined, { READER_ONLINE_URL: home })
  const remote = await site(h)
  await remote.getByRole('link', { name: '超时书籍链接' }).click({ noWaitAfter: true })
  await expect(remote.getByRole('heading', { name: 'Connection timed out' })).toBeVisible()
  await expect(h.page.locator('.online__error')).toContainText('522')
  await expect(h.page.locator('.online__error')).toContainText('网站服务器连接超时')
  await expect(h.page.locator('.online__error')).not.toContainText('操作失败')
})

test('a real book-cover click opens the exact cross-site book and skips its click-ad handler', async () => {
  const h = await launch(undefined, { READER_ONLINE_URL: home })
  const remote = await site(h)
  await remote.getByRole('img', { name: '图书封面' }).click()
  await expect(remote.getByRole('heading', { name: '另一个站点' })).toBeVisible()
  expect(remote.url()).toBe(`${outside}/book/detail`)
  expect(outsidePaths).toContain('/book/detail')
  expect(outsidePaths).not.toContain('/shopping')
  await expect(h.page.getByTestId('blocked-navigation')).toHaveCount(0)
  expect(h.app.context().pages()).toHaveLength(2)
  await h.page.getByRole('button', { name: '网站首页', exact: true }).click()
  await expect(remote.getByRole('heading', { name: '在线书库' })).toBeVisible()
  await remote.evaluate(destination => { window.location.href = destination }, `${outside}/shopping`)
  await expect(h.page.getByTestId('blocked-navigation')).toBeVisible()
  expect(outsidePaths).not.toContain('/shopping')
})

test('website back keeps history semantics across clicked sites without creating extra entries', async () => {
  const h = await launch(undefined, { READER_ONLINE_URL: home })
  const remote = await site(h)
  await remote.getByRole('img', { name: '图书封面' }).click()
  await expect.poll(() => remote.url()).toBe(`${outside}/book/detail`)
  await h.page.getByRole('button', { name: '网站首页', exact: true }).click()
  await expect(remote.getByRole('heading', { name: '在线书库' })).toBeVisible()
  await h.page.getByRole('button', { name: '网站后退', exact: true }).click()
  await expect.poll(() => remote.url()).toBe(`${outside}/book/detail`)
  await h.page.getByRole('button', { name: '网站后退', exact: true }).click()
  await expect.poll(() => remote.url()).toBe(home)
  await expect(h.page.getByRole('button', { name: '网站后退', exact: true })).toBeDisabled()
})

test('keyboard activation of an external book link works without granting synthetic site clicks permission', async () => {
  const h = await launch(undefined, { READER_ONLINE_URL: home })
  const remote = await site(h)
  await remote.locator('[data-book-cover]').focus()
  await remote.keyboard.press('Enter')
  await expect.poll(() => remote.url()).toBe(`${outside}/book/detail`)
  expect(outsidePaths).not.toContain('/shopping')
})

test('script-generated clicks cannot forge permission to leave the current site', async () => {
  const h = await launch(undefined, { READER_ONLINE_URL: home })
  const remote = await site(h)
  await remote.getByRole('link', { name: '站外跳转', exact: true }).evaluate(link => (link as HTMLAnchorElement).click())
  await expect(h.page.getByTestId('blocked-navigation')).toBeVisible()
  expect(remote.url()).toBe(home)
  expect(outsideRequests).toBe(0)
})

test('download attributes and hash-based site controls retain their intended behavior', async () => {
  const h = await launch(undefined, { READER_ONLINE_URL: home })
  const remote = await site(h)
  await remote.getByRole('link', { name: '下载属性 EPUB' }).click()
  await expect(h.page.getByTestId('download-task')).toContainText('已加入默认书库')
  expect(remote.url()).toBe(home)
  await remote.getByRole('link', { name: '展开菜单' }).click()
  await expect(remote.getByRole('heading', { name: '菜单已展开' })).toBeVisible()
})
