import { expect, test } from '@playwright/test'
import {
  closeAllApps,
  configureLlm,
  importFixture,
  importRealisticFixture,
  launch,
  pressUntilPageChanges,
  waitForLocationsReady
} from './helpers'
import { closeAllFakeLlms, startFakeLlm } from './fake-llm'

test.afterEach(async () => {
  await closeAllApps()
  await closeAllFakeLlms()
})

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

test('阅读页开始翻译后顶部可切换译文，翻页自动译下一页，缓存重开保留', async () => {
  const h = await launch()
  const fake = await startFakeLlm()
  await importFixture(h)
  await configureLlm(h, { endpoint: fake.url })
  // 在书架为本书开启翻译。
  await h.page.getByTestId('toggle-translation').first().click()
  await expect(h.page.getByTestId('toggle-translation').first()).toHaveAttribute('aria-pressed', 'true')

  await h.page.getByTestId('book-card').first().click()
  await h.page.getByTestId('reader-page').waitFor()
  await waitForLocationsReady(h)

  // 未开始前提示点击开始，不调模型。
  await expect(h.page.getByTestId('translation-bar')).toBeVisible()
  await expect(h.page.getByTestId('translation-status')).toContainText('点击“开始翻译”')
  expect(fake.requests).toHaveLength(0)

  // 点击开始翻译：只译本页，译完自动准备下一页，不会一次性全书翻译。
  await h.page.getByTestId('translation-start').click()
  const view = h.page.getByTestId('translation-view')
  await expect(view).toBeVisible({ timeout: 30_000 })
  await expect(view).toContainText('这是假的回答。', { timeout: 30_000 })
  expect(fake.requests.length).toBeGreaterThanOrEqual(1)
  // 发给模型的是翻译指令，不是闲聊。
  const lastBody = fake.requests.at(-1)?.body.messages?.map((m) => m.content).join('\n') ?? ''
  expect(lastBody).toContain('翻译成简体中文')

  // 顶部切换：切回原文隐藏译文，再切回来秒显（缓存）。
  await h.page.getByTestId('translation-toggle').click()
  await expect(view).toBeHidden()
  await h.page.getByTestId('translation-toggle').click()
  await expect(view).toBeVisible()
  await expect(view).toContainText('这是假的回答。')

  const requestsAfterFirstPage = fake.requests.length

  // 翻页后自动翻译下一页（2 页窗口， sequential）。
  await pressUntilPageChanges(h, 'ArrowRight')
  await expect(view).toContainText('这是假的回答。', { timeout: 30_000 })
  // 翻页触发了新页翻译（缓存未命中时新增请求；若命中则不新增，只断言最终有译文）。
  expect(fake.requests.length).toBeGreaterThanOrEqual(requestsAfterFirstPage)

  // 回书架重开：缓存保留，开始后直接显示，不再新增模型请求。
  await h.page.getByRole('button', { name: '← 书架' }).click()
  await expect(h.page.getByTestId('library')).toBeVisible()
  const beforeReopen = fake.requests.length
  await h.page.getByTestId('book-card').first().click()
  await h.page.getByTestId('reader-page').waitFor()
  await waitForLocationsReady(h)
  await h.page.getByTestId('translation-start').click()
  await expect(h.page.getByTestId('translation-view')).toContainText('这是假的回答。', { timeout: 30_000 })
  expect(fake.requests.length).toBe(beforeReopen)
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
