import { expect, test } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import {
  closeAllApps,
  configureLlm,
  importFixture,
  importRealisticFixture,
  launch,
  pressUntilPageChanges,
  waitForLocationsReady,
  type Harness
} from './helpers'
import { closeAllFakeLlms, startFakeLlm, type FakeLlm } from './fake-llm'

test.afterEach(async () => {
  await closeAllApps()
  await closeAllFakeLlms()
})

/** 等假模型的请求数稳定下来（后台预取/翻译全部落定），返回稳定后的请求数。 */
async function waitForFakeQuiescent(fake: FakeLlm, timeoutMs = 45_000): Promise<number> {
  const start = Date.now()
  let last = fake.requests.length
  let stableSince = Date.now()
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 300))
    if (fake.requests.length !== last) {
      last = fake.requests.length
      stableSince = Date.now()
    } else if (Date.now() - stableSince >= 2000) {
      return last
    }
  }
  return last
}

async function openTranslatedBook(h: Harness, fake: FakeLlm): Promise<void> {
  await importFixture(h)
  await configureLlm(h, { endpoint: fake.url })
  await h.page.getByTestId('toggle-translation').first().click()
  await expect(h.page.getByTestId('toggle-translation').first()).toHaveAttribute('aria-pressed', 'true')
  await h.page.getByTestId('book-card').first().click()
  await h.page.getByTestId('reader-page').waitFor()
  await waitForLocationsReady(h)
}

test('书架翻译开关默认关闭、按书独立、重启保留', async () => {  const h = await launch()
  await importFixture(h)
  await importRealisticFixture(h)
  const toggles = h.page.getByTestId('toggle-translation')
  await expect(toggles).toHaveCount(2)
  // 默认关闭。
  await expect(toggles.nth(0)).toHaveAttribute('aria-pressed', 'false')
  await expect(toggles.nth(1)).toHaveAttribute('aria-pressed', 'false')

  // 只开第一本，第二本不受影响。
  await toggles.nth(0).click()
  await expect(toggles.nth(0)).toHaveAttribute('aria-pressed', 'true')
  await expect(toggles.nth(0)).toContainText('译·开')
  await expect(toggles.nth(1)).toHaveAttribute('aria-pressed', 'false')

  // 重启后保留。
  const userData = h.userData
  await closeAllApps()
  const h2 = await launch(userData)
  await expect(h2.page.getByTestId('book-card').first()).toBeVisible({ timeout: 30_000 })
  const toggles2 = h2.page.getByTestId('toggle-translation')
  await expect(toggles2).toHaveCount(2)
  // 书架按最近阅读排序，开关状态跟书走，不跟位置走：恰有一开一关。
  const pressed = await toggles2.evaluateAll((els) =>
    els.map((el) => el.getAttribute('aria-pressed'))
  )
  expect(pressed.sort()).toEqual(['false', 'true'])
})

test('开始翻译后顶部切换译文：下一页后台预取，翻回零请求，重开缓存保留', async () => {
  const h = await launch()
  const fake = await startFakeLlm()
  await openTranslatedBook(h, fake)

  // 未开始前不调模型：阅读页总开关已开，开始按钮可见。
  await expect(h.page.getByTestId('translation-enable')).toHaveAttribute('aria-pressed', 'true')
  await expect(h.page.getByTestId('translation-start')).toBeVisible()
  expect(fake.requests).toHaveLength(0)

  // 点击开始翻译：按内容分句翻译，不一次性全书翻译。
  await h.page.getByTestId('translation-start').click()
  const view = h.page.getByTestId('translation-view')
  await expect(view).toBeVisible({ timeout: 30_000 })
  await expect(view).toContainText('这是假的回答。', { timeout: 30_000 })
  // 译文按原文段落分段，不挤在一起。
  await expect.poll(async () => view.textContent(), { timeout: 30_000 }).toContain('\n\n')
  // 发给模型的是编号分段翻译指令，不是闲聊。
  const bodies = fake.requests.map((r) => r.body.messages?.map((m) => m.content).join('\n') ?? '').join('\n')
  expect(bodies).toContain('逐段翻译')

  // 顶部切换：切回原文隐藏译文，再切回来秒显（内存缓存）。
  await h.page.getByTestId('translation-toggle').click()
  await expect(view).toBeHidden()
  await h.page.getByTestId('translation-toggle').click()
  await expect(view).toBeVisible()
  await expect(view).toContainText('这是假的回答。')

  // 等后台预取落定（下一页应已被预取翻译）。再翻页： indicator 一变就断言——
  // 译文必须已在（预取命中），且尚未新增任何模型请求。谁先发生谁定胜负，不存在竞态。
  const settled = await waitForFakeQuiescent(fake)
  expect(settled).toBeGreaterThanOrEqual(1)
  const indicator = h.page.getByTestId('page-indicator')
  const beforeFlip = await indicator.textContent()
  await h.page.keyboard.press('ArrowRight')
  await expect.poll(async () => indicator.textContent(), { timeout: 15_000 }).not.toBe(beforeFlip)
  await expect(view).toContainText('这是假的回答。', { timeout: 15_000 })
  expect(fake.requests.length).toBe(settled)
  // 随后后台预取下下页会再加最多一个请求；落定后记为 settled2。
  const settled2 = await waitForFakeQuiescent(fake)
  expect(settled2 - settled).toBeLessThanOrEqual(1)

  // 翻回已译过的上一页：记号存在，零新增请求。
  await pressUntilPageChanges(h, 'ArrowLeft')
  await expect(view).toContainText('这是假的回答。', { timeout: 30_000 })
  expect(fake.requests.length).toBe(settled2)
  await waitForFakeQuiescent(fake)
  expect(fake.requests.length).toBe(settled2)

  // 回书架重开：分句缓存永久保留，开始后直接显示，零新增模型请求。
  await h.page.getByRole('button', { name: '← 书架' }).click()
  await expect(h.page.getByTestId('library')).toBeVisible()
  await h.page.getByTestId('book-card').first().click()
  await h.page.getByTestId('reader-page').waitFor()
  await waitForLocationsReady(h)
  await h.page.getByTestId('translation-start').click()
  await expect(h.page.getByTestId('translation-view')).toContainText('这是假的回答。', { timeout: 30_000 })
  await waitForFakeQuiescent(fake)
  expect(fake.requests.length).toBe(settled2)
})

test('改小字号不重翻整书：迁移的分句直接复用，只译新露出的部分', async () => {
  const h = await launch()
  const fake = await startFakeLlm()
  await openTranslatedBook(h, fake)

  await h.page.getByTestId('translation-start').click()
  const view = h.page.getByTestId('translation-view')
  await expect(view).toContainText('这是假的回答。', { timeout: 30_000 })
  const settled = await waitForFakeQuiescent(fake)

  // 缩小字号：单页容纳更多文字。复用的证明是请求体：新增请求里不得包含第一页已译过的句子
  // （整页重翻会把它们再发一遍）；只允许分页边界碎句带来最多一个新增请求。
  await h.page.getByRole('button', { name: '缩小字号' }).click()
  await expect(view).toContainText('这是假的回答。', { timeout: 30_000 })
  const afterShrink = await waitForFakeQuiescent(fake)
  expect(afterShrink - settled).toBeLessThanOrEqual(1)
  const newBodies = fake.requests
    .slice(settled)
    .map((r) => r.body.messages?.map((m) => m.content).join('\n') ?? '')
    .join('\n')
  expect(newBodies).not.toContain('只保证每次生成完全相同')

  // 翻到下一页：仅下下页新露出的分句需要翻译（最多一批到达请求 + 一批后台预取）。
  await pressUntilPageChanges(h, 'ArrowRight')
  await expect(view).toContainText('这是假的回答。', { timeout: 30_000 })
  const afterFlip = await waitForFakeQuiescent(fake)
  expect(afterFlip - afterShrink).toBeLessThanOrEqual(2)
})

test('阅读页可直接开关本书翻译，无需退回书架', async () => {
  const h = await launch()
  const fake = await startFakeLlm()
  await importFixture(h)
  await configureLlm(h, { endpoint: fake.url })
  await h.page.getByTestId('book-card').first().click()
  await h.page.getByTestId('reader-page').waitFor()
  await waitForLocationsReady(h)

  // 默认关闭：只有总开关（关态），无开始按钮。
  const enable = h.page.getByTestId('translation-enable')
  await expect(enable).toHaveAttribute('aria-pressed', 'false')
  await expect(h.page.getByTestId('translation-start')).toHaveCount(0)

  // 阅读页直接开启：出现开始按钮；开始翻译得到译文。
  await enable.click()
  await expect(enable).toHaveAttribute('aria-pressed', 'true')
  await h.page.getByTestId('translation-start').click()
  const view = h.page.getByTestId('translation-view')
  await expect(view).toContainText('这是假的回答。', { timeout: 30_000 })
  expect(fake.requests.length).toBeGreaterThanOrEqual(1)

  // 阅读页直接关闭：入口收起、译文隐藏；再开启后缓存仍在，零新增请求。
  const settled = await waitForFakeQuiescent(fake)
  await enable.click()
  await expect(enable).toHaveAttribute('aria-pressed', 'false')
  await expect(view).toBeHidden()
  await expect(h.page.getByTestId('translation-start')).toHaveCount(0)
  await enable.click()
  await expect(enable).toHaveAttribute('aria-pressed', 'true')
  // 无需再次点击开始：会话意图保留，缓存秒显（内存已清，走一次本地缓存 IPC），零新增模型请求。
  await expect(view).toContainText('这是假的回答。', { timeout: 30_000 })
  await waitForFakeQuiescent(fake)
  expect(fake.requests.length).toBe(settled)

  // 书架开关同步：回书架看到本书已是开态（同一落盘位）。
  await h.page.getByRole('button', { name: '← 书架' }).click()
  await expect(h.page.getByTestId('library')).toBeVisible()
  await expect(h.page.getByTestId('toggle-translation').first()).toHaveAttribute('aria-pressed', 'true')
})

test('未在书架开启翻译时阅读页只有总开关，不调模型', async () => {
  const h = await launch()
  const fake = await startFakeLlm()
  await importFixture(h)
  await configureLlm(h, { endpoint: fake.url })
  await h.page.getByTestId('book-card').first().click()
  await h.page.getByTestId('reader-page').waitFor()
  await waitForLocationsReady(h)
  await expect(h.page.getByTestId('translation-enable')).toHaveAttribute('aria-pressed', 'false')
  await expect(h.page.getByTestId('translation-start')).toHaveCount(0)
  await expect(h.page.getByTestId('translation-toggle')).toHaveCount(0)
  expect(fake.requests).toHaveLength(0)
})

/**
 * 用 div 排版 + <br/> 换行的书：译文必须按原文段落分开显示，不能挤成一整坨。
 * 样本书在测试内现造（最小合法 EPUB3），不碰其它用例依赖的共享样本。
 */
async function buildDivBrEpub(): Promise<Uint8Array> {
  const zip = new JSZip()
  const date = new Date('1980-01-01T00:00:00Z')
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE', date, createFolders: false })
  zip.file(
    'META-INF/container.xml',
    '<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    { date, createFolders: false }
  )
  zip.file(
    'OEBPS/content.opf',
    '<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">urn:uuid:reader-divbr-0001</dc:identifier><dc:title>杂排之书</dc:title><dc:creator>测试作者</dc:creator><dc:language>zh-CN</dc:language><meta property="dcterms:modified">2020-01-01T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="ch1"/></spine></package>',
    { date, createFolders: false }
  )
  zip.file(
    'OEBPS/nav.xhtml',
    '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN"><head><title>目录</title></head><body><nav epub:type="toc"><h1>目录</h1><ol><li><a href="ch1.xhtml">第一章 杂排</a></li></ol></nav></body></html>',
    { date, createFolders: false }
  )
  const paras = Array.from({ length: 8 }, (_, i) => `这是第${i + 1}个 div 段落，用于验证杂乱排版的译文分段。它没有实际含义，只保证每次生成完全相同。这是本段的第二句。`)
  zip.file(
    'OEBPS/ch1.xhtml',
    `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN"><head><title>第一章 杂排</title></head><body><h1>第一章 杂排</h1><div class="para">${paras[0]}${paras[1]}</div><div class="para">${paras[2]}<br/>这是 br 后的行。<br/><br/>${paras[3]}</div><div class="para">${paras[4]}</div><div class="para">${paras[5]}</div><div class="para">${paras[6]}</div><div class="para">${paras[7]}</div></body></html>`,
    { date, createFolders: false }
  )
  return zip.generateAsync({ type: 'uint8array' })
}

test('div 与 br 排版的书同样按段落显示译文', async () => {
  const h = await launch()
  const fake = await startFakeLlm()
  const workDir = mkdtempSync(join(tmpdir(), 'reader-e2e-divbr-'))
  const divbrPath = join(workDir, '杂排之书.epub')
  writeFileSync(divbrPath, await buildDivBrEpub())
  await h.page.evaluate((p) => {
    ;(window as unknown as { __E2E_FILES__?: string[] }).__E2E_FILES__ = [p]
  }, divbrPath)
  await h.page.getByTestId('pick-files').click()
  await h.page.getByTestId('book-card').first().waitFor({ timeout: 30_000 })
  await configureLlm(h, { endpoint: fake.url })
  await h.page.getByTestId('toggle-translation').first().click()
  await h.page.getByTestId('book-card').first().click()
  await h.page.getByTestId('reader-page').waitFor()
  await waitForLocationsReady(h)
  await h.page.getByTestId('translation-start').click()
  const view = h.page.getByTestId('translation-view')
  await expect(view).toContainText('这是假的回答。', { timeout: 30_000 })
  // 首页多个 div 段落 + br 空行：译文必须出现多个空行分隔，而不是一整坨。
  const text = await view.textContent()
  const blocks = (text ?? '').split('\n\n').map((b) => b.trim()).filter(Boolean)
  expect(blocks.length).toBeGreaterThanOrEqual(3)
})
