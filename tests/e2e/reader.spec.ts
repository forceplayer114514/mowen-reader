import { expect, test } from '@playwright/test'
import { importFixture, launch, waitForLocationsReady, type Harness } from './helpers'

test('导入一本书后书架上能看到书名和作者', async () => {
  const h: Harness = await launch()
  await importFixture(h)
  await expect(h.page.getByText('测试之书')).toBeVisible()
  await expect(h.page.getByText('测试作者')).toBeVisible()
  await h.app.close()
})

test('打开书能看到正文,右方向键能翻页且页码递增', async () => {
  const h = await launch()
  await importFixture(h)
  await h.page.getByTestId('book-card').first().click()
  await h.page.getByTestId('reader-page').waitFor()

  const indicator = h.page.getByTestId('page-indicator')
  await expect(indicator).toContainText('页', { timeout: 40_000 })
  await expect(indicator).not.toContainText('正在计算', { timeout: 60_000 })

  const before = await indicator.textContent()
  await h.page.keyboard.press('ArrowRight')
  await expect(indicator).not.toHaveText(before!, { timeout: 15_000 })

  await h.page.keyboard.press('ArrowLeft')
  await expect(indicator).toHaveText(before!, { timeout: 15_000 })
  await h.app.close()
})

test('目录列出三章,点第二章后底部章节名跟着变', async () => {
  const h = await launch()
  await importFixture(h)
  await h.page.getByTestId('book-card').first().click()
  await h.page.getByTestId('reader-page').waitFor()

  await h.page.getByTestId('toggle-toc').click()
  const toc = h.page.getByTestId('toc')
  await expect(toc.getByText('第一章 开端')).toBeVisible()
  await expect(toc.getByText('第三章 归途')).toBeVisible()

  await toc.getByText('第二章 那个夏天').click()
  await expect(h.page.getByTestId('reader-foot')).toContainText('第二章 那个夏天', {
    timeout: 20_000
  })
  await h.app.close()
})

test('关掉应用重开,回到上次读到的位置', async () => {
  const first = await launch()
  await importFixture(first)
  await first.page.getByTestId('book-card').first().click()
  await first.page.getByTestId('reader-page').waitFor()
  const indicator = first.page.getByTestId('page-indicator')
  await expect(indicator).not.toContainText('正在计算', { timeout: 60_000 })

  for (let i = 0; i < 5; i++) await first.page.keyboard.press('ArrowRight')
  const stopped = await indicator.textContent()
  await first.page.waitForTimeout(1500)
  await first.app.close()

  const second = await launch(first.userData)
  await second.page.getByTestId('book-card').first().click()
  await expect(second.page.getByTestId('page-indicator')).toHaveText(stopped!, {
    timeout: 60_000
  })
  await second.app.close()
})

// --- 以下是任务补充的风险场景,brief 的四个用例之外 ---

test('先点进书内正文(iframe 内部),方向键依然能翻页', async () => {
  const h = await launch()
  await importFixture(h)
  await h.page.getByTestId('book-card').first().click()
  await h.page.getByTestId('reader-page').waitFor()
  await waitForLocationsReady(h)

  const indicator = h.page.getByTestId('page-indicator')
  const before = await indicator.textContent()

  // 正文渲染在 epub.js 生成的 iframe 里,按键事件的落点和外层窗口是两个不同的
  // document——先把焦点点进 iframe 内容本身,再模拟按键,才是真实用户翻页的路径。
  const frame = h.page.frameLocator('[data-testid="reader-page"] iframe')
  await frame.locator('body').click()

  await h.page.keyboard.press('ArrowRight')
  await expect(indicator).not.toHaveText(before!, { timeout: 15_000 })
  await h.app.close()
})

test('放大字号后页码指示器不变,阅读位置也还在原处', async () => {
  const h = await launch()
  await importFixture(h)
  await h.page.getByTestId('book-card').first().click()
  await h.page.getByTestId('reader-page').waitFor()
  await waitForLocationsReady(h)

  // 先翻几页,离开第 1 页——停在第 1 页的话,字号变化前后凑巧没变说明不了问题。
  for (let i = 0; i < 5; i++) await h.page.keyboard.press('ArrowRight')

  const indicator = h.page.getByTestId('page-indicator')
  const foot = h.page.getByTestId('reader-foot')
  const beforeIndicator = await indicator.textContent()
  const beforeFoot = await foot.textContent()

  // 页码来自内容索引,不是排版,字号变化不应该让它跟着变——见 task-12-brief 之外
  // 的补充要求。如果这里指示器变了,说明页码其实还是从当前渲染布局算出来的,
  // 是一个需要报告的缺陷。
  await h.page.getByRole('button', { name: '放大字号' }).click()
  await h.page.waitForTimeout(500)

  await expect(indicator).toHaveText(beforeIndicator!)
  await expect(foot).toHaveText(beforeFoot!)

  // 阅读位置没有被字号变化悄悄重置:从这里继续翻页/退回,应该还是正常的相邻页序列,
  // 而不是跳回第一页或跳到别的章节。
  await h.page.keyboard.press('ArrowRight')
  await expect(indicator).not.toHaveText(beforeIndicator!, { timeout: 15_000 })
  await h.page.keyboard.press('ArrowLeft')
  await expect(indicator).toHaveText(beforeIndicator!, { timeout: 15_000 })

  await h.app.close()
})

test('书还在加载时就离开阅读界面,不崩溃且能回到书架', async () => {
  const h = await launch()
  await importFixture(h)

  const pageErrors: Error[] = []
  h.page.on('pageerror', (err) => pageErrors.push(err))

  await h.page.getByTestId('book-card').first().click()
  // 不等 reader-page / 位置索引就绪,立刻点返回——刻意打在 boot() 还没跑完的窗口上,
  // 用来验证 ReaderView 卸载时的 cancelled 标记和 engine.destroy() 清理路径。
  await h.page.getByRole('button', { name: '← 书架' }).click()

  await expect(h.page.getByTestId('library')).toBeVisible()
  await expect(h.page.getByTestId('book-card').first()).toBeVisible()

  // 返回书架后界面要仍然可用,不是卡死的空壳——能再次进入阅读界面。
  await h.page.getByTestId('book-card').first().click()
  await h.page.getByTestId('reader-page').waitFor({ timeout: 30_000 })

  expect(pageErrors, `不应该有未捕获的异常:${pageErrors.map((e) => e.message).join('; ')}`).toEqual(
    []
  )
  await h.app.close()
})

test('切换主题后重启应用,设置仍然是切换后的主题', async () => {
  const first = await launch()
  await importFixture(first)
  await first.page.getByTestId('book-card').first().click()
  await first.page.getByTestId('reader-page').waitFor()

  const themeBefore = await first.page.evaluate(() => window.api.getSetting('theme'))
  expect(themeBefore).toBeNull() // 默认没存过,读出来是 null,ReaderView 里按 'light' 兜底

  await first.page.getByRole('button', { name: '夜间' }).click()
  await expect(first.page.getByRole('button', { name: '日间' })).toBeVisible()
  await expect
    .poll(() => first.page.evaluate(() => window.api.getSetting('theme')))
    .toBe('dark')

  await first.app.close()

  const second = await launch(first.userData)
  const themeAfterRestart = await second.page.evaluate(() => window.api.getSetting('theme'))
  expect(themeAfterRestart).toBe('dark')

  // 重新打开书,阅读界面应该直接以深色主题呈现,而不是又回退到默认的浅色。
  await second.page.getByTestId('book-card').first().click()
  await second.page.getByTestId('reader-page').waitFor()
  await expect(second.page.getByRole('button', { name: '日间' })).toBeVisible()
  const dataTheme = await second.page.evaluate(() => document.documentElement.dataset.theme)
  expect(dataTheme).toBe('dark')

  await second.app.close()
})
