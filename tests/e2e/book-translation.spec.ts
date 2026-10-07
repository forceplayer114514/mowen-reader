import { expect, test } from '@playwright/test'
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

test('书架翻译开关默认关闭、按书独立、重启保留', async () => {
  const h = await launch()
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

  // 未开始前提示点击开始，不调模型。
  await expect(h.page.getByTestId('translation-bar')).toBeVisible()
  await expect(h.page.getByTestId('translation-status')).toContainText('点击“开始翻译”')
  expect(fake.requests).toHaveLength(0)

  // 点击开始翻译：按内容分句翻译，不一次性全书翻译。
  await h.page.getByTestId('translation-start').click()
  const view = h.page.getByTestId('translation-view')
  await expect(view).toBeVisible({ timeout: 30_000 })
  await expect(view).toContainText('这是假的回答。', { timeout: 30_000 })
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

test('未在书架开启翻译时阅读页不提供翻译入口', async () => {
  const h = await launch()
  const fake = await startFakeLlm()
  await importFixture(h)
  await configureLlm(h, { endpoint: fake.url })
  await h.page.getByTestId('book-card').first().click()
  await h.page.getByTestId('reader-page').waitFor()
  await waitForLocationsReady(h)
  await expect(h.page.getByTestId('translation-bar')).toHaveCount(0)
  await expect(h.page.getByTestId('translation-start')).toHaveCount(0)
  await expect(h.page.getByTestId('translation-toggle')).toHaveCount(0)
  expect(fake.requests).toHaveLength(0)
})
