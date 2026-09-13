import { expect, test } from '@playwright/test'
import {
  closeAllApps,
  importFixture,
  importRealisticFixture,
  launch,
  pressAndSettle,
  pressUntilPageChanges,
  waitForLocationsReady,
  waitForStableIndicator,
  type Harness
} from './helpers'

// 不管测试是正常跑完还是中途断言失败提前退出,都要把这个测试里 launch() 启动过的
// 所有 Electron app 关掉——否则一次失败就会在测试结束的那行 close() 之前直接跳出,
// 留下的进程和临时数据目录在 CI 上跑几次失败就会越攒越多。见 helpers.ts 里
// closeAllApps() 的注释:它对重复关闭是安全的,所以正文里为了验证"关掉重开"这类
// 场景而主动调用的 app.close() 不需要跟这里的收尾互相协调。
test.afterEach(async () => {
  await closeAllApps()
})

test('导入一本书后书架上能看到书名和作者', async () => {
  const h: Harness = await launch()
  await importFixture(h)
  // 没有封面图时,封面占位区会把书名当占位文字显示(book-card__cover),标题栏
  // (book-card__title)也显示同一个书名——两处文字完全相同是有意的封面兜底设计,
  // 所以这里用 class 定位到标题栏本身,而不是用 getByText 摸文字,否则会因为
  // 页面里同一段文字出现两次而撞上 strict mode violation。
  await expect(h.page.locator('.book-card__title')).toHaveText('测试之书')
  await expect(h.page.locator('.book-card__author')).toHaveText('测试作者')
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
})

// --- 以下用更接近真实排版的样本(fix 1)覆盖简单样本测不到的场景 ---

test('真实排版样本:目录链接带 ../ 前缀,页脚仍能显示章节名、目录跳转仍然生效', async () => {
  const h = await launch()
  await importRealisticFixture(h)
  await h.page.getByTestId('book-card').first().click()
  await h.page.getByTestId('reader-page').waitFor()

  // 这本样本的目录(EPUB 3 nav)把链接写成 "../Text/ch1.xhtml",而 spine 报告的
  // 章节路径是 "Text/ch1.xhtml"——按原始字符串比较的话,章节名永远匹配不上、
  // 页脚会一直空着。见 engine.ts 里 normalizeChapterHref 的用法。
  await expect(h.page.getByTestId('reader-foot')).toContainText('第一章 楔子', {
    timeout: 20_000
  })

  await h.page.getByTestId('toggle-toc').click()
  const toc = h.page.getByTestId('toc')
  await expect(toc.getByText('第一章 楔子')).toBeVisible()
  // 第二级目录条目(章节内的小节),验证多级目录能正常展开而不是被拍平。
  await expect(toc.getByText('第一节 起')).toBeVisible()
  await expect(toc.getByText('第三章 尾声')).toBeVisible()

  await toc.getByText('第二章 正文').click()
  await expect(h.page.getByTestId('reader-foot')).toContainText('第二章 正文', {
    timeout: 20_000
  })

  // 再跳到第一章里带 #锚点 的小节链接:应该落回第一章,而不是因为锚点导致匹配不上
  // 目录条目、章节名又变回空白。
  await h.page.getByTestId('toggle-toc').click()
  await h.page.getByTestId('toc').getByText('第一节 起').click()
  await expect(h.page.getByTestId('reader-foot')).toContainText('第一章 楔子', {
    timeout: 20_000
  })
})

test('关掉应用重开,回到上次读到的位置', async () => {
  const first = await launch()
  await importFixture(first)
  await first.page.getByTestId('book-card').first().click()
  await first.page.getByTestId('reader-page').waitFor()
  const indicator = first.page.getByTestId('page-indicator')
  await expect(indicator).not.toContainText('正在计算', { timeout: 60_000 })

  // pressAndSettle 逐次按键并等每一次翻页真正落地再按下一次,拿到的是 5 次
  // 翻页全部完成、已经落盘之后稳定下来的页码——不能一口气按 5 次键立刻读
  // textContent(),翻页要经过 iframe 排版和 epub.js 内部的异步队列才会生效,
  // 读早了拿到的只是没翻完时的旧文字,后面重启读到的持久化位置反而更靠后,
  // 两边对不上——这不是应用的缺陷,是测试自己没等稳定的时序问题。
  const stopped = await pressAndSettle(first, 'ArrowRight', 5)
  await first.page.waitForTimeout(1500)
  await first.app.close()

  const second = await launch(first.userData)
  await second.page.getByTestId('book-card').first().click()
  await expect(second.page.getByTestId('page-indicator')).toHaveText(stopped!, {
    timeout: 60_000
  })
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
})

test('放大字号后页码指示器不变,阅读位置也还在原处', async () => {
  const h = await launch()
  await importFixture(h)
  await h.page.getByTestId('book-card').first().click()
  await h.page.getByTestId('reader-page').waitFor()
  await waitForLocationsReady(h)

  // 先翻几页,离开第 1 页——停在第 1 页的话,字号变化前后凑巧没变说明不了问题。
  // 用 pressAndSettle 逐次按键并等每次翻页落地,而不是连按 5 次立刻读
  // textContent():翻页要经过异步的排版和队列才生效,不等就读只会读到翻页
  // 途中的旧文字,跟字号变化是否影响页码无关,是时序问题。
  await pressAndSettle(h, 'ArrowRight', 5)

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
  // 而不是跳回第一页或跳到别的章节。内容索引的分段和物理翻页屏幕不是 1:1 对齐的
  // (见 helpers.ts 里 pressUntilPageChanges 的注释),往前翻 N 屏再往回翻同样 N 屏,
  // 如果正好落在分段边界附近,回来的分段编号可能和出发时差 1(边界两侧各自的取整
  // 方向不对称,不是缺陷),所以不要求精确回到 beforeIndicator,
  // 而是断言仍在同一章、页码在原处 ±1 以内——这样仍然能抓住"字号变化把阅读位置
  // 悄悄重置到第 1 页或者跳到别的章节"这种真正的缺陷。
  const stepsForward = await pressUntilPageChanges(h, 'ArrowRight')
  for (let i = 0; i < stepsForward; i++) await h.page.keyboard.press('ArrowLeft')
  const finalIndicator = await waitForStableIndicator(h)
  const finalFoot = await foot.textContent()

  const pageOf = (text: string): number => Number(/第 (\d+) \//.exec(text)?.[1])
  expect(
    Math.abs(pageOf(finalIndicator) - pageOf(beforeIndicator!)),
    `往前 ${stepsForward} 屏再往回 ${stepsForward} 屏之后,页码从 ${beforeIndicator} 变成了 ${finalIndicator},偏得太远,像是位置被悄悄重置了`
  ).toBeLessThanOrEqual(1)
  expect(finalFoot?.endsWith(finalIndicator)).toBe(true)
  expect(
    finalFoot?.slice(0, finalFoot.length - finalIndicator.length),
    '往回翻页之后章节名变了,阅读位置像是跳到了别的章节'
  ).toBe(beforeFoot?.slice(0, beforeFoot.length - beforeIndicator!.length))
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

  // 冷启动直接停在书架、还没点开任何一本书:书架本身也要按存储的主题渲染,
  // 不能停在浅色等用户先打开一本书才纠正过来——这是应用入口在渲染之前
  // 读一次设置的效果,覆盖的是书架这个场景,不依赖 ReaderView 是否挂载过。
  await expect(second.page.getByTestId('library')).toBeVisible()
  const shelfDataTheme = await second.page.evaluate(() => document.documentElement.dataset.theme)
  expect(shelfDataTheme).toBe('dark')

  // 重新打开书,阅读界面应该直接以深色主题呈现,而不是又回退到默认的浅色。
  await second.page.getByTestId('book-card').first().click()
  await second.page.getByTestId('reader-page').waitFor()
  await expect(second.page.getByRole('button', { name: '日间' })).toBeVisible()
  const dataTheme = await second.page.evaluate(() => document.documentElement.dataset.theme)
  expect(dataTheme).toBe('dark')

  // 从阅读界面退回书架,主题不应该被悄悄改回默认值——书架和阅读界面共用同一个
  // 全局 data-theme 属性,退回书架这个卸载动作本身不该触碰它。
  await second.page.getByRole('button', { name: '← 书架' }).click()
  await expect(second.page.getByTestId('library')).toBeVisible()
  const shelfDataThemeAfterBack = await second.page.evaluate(
    () => document.documentElement.dataset.theme
  )
  expect(shelfDataThemeAfterBack).toBe('dark')
})

test('删除书之后书架恢复空状态,重启也不会把它带回来', async () => {
  const h = await launch()
  await importFixture(h)
  await expect(h.page.getByTestId('book-card')).toHaveCount(1)

  // 删除按钮平时靠 hover 才会显示(见 theme.css 里 .book-card__delete 的
  // opacity 规则),但它本来就一直在 DOM 里,Playwright 点隐藏但存在的元素
  // 不需要真的先触发 hover。点删除按钮应该只弹出确认框,不应该直接把书删掉,
  // 也不应该顺带触发卡片本身的 onClick 把书打开。
  await h.page.getByTestId('delete-book').click()
  await expect(h.page.getByTestId('reader-page')).toHaveCount(0)

  const confirmDialog = h.page.getByTestId('confirm-delete')
  await expect(confirmDialog).toBeVisible()
  await expect(confirmDialog).toContainText('测试之书')

  // 先点取消:书应该还在,确认框应该消失。
  await h.page.getByRole('button', { name: '取消' }).click()
  await expect(confirmDialog).toHaveCount(0)
  await expect(h.page.getByTestId('book-card')).toHaveCount(1)

  // 再走一次真正的删除。
  await h.page.getByTestId('delete-book').click()
  await h.page.getByTestId('confirm-delete-yes').click()
  await expect(h.page.getByTestId('confirm-delete')).toHaveCount(0)
  await expect(h.page.getByText('书架是空的')).toBeVisible()
  await expect(h.page.getByTestId('book-card')).toHaveCount(0)

  await h.app.close()

  // 重启之后,删掉的书不应该因为某种缓存或者没落库而又冒出来。
  const second = await launch(h.userData)
  await expect(second.page.getByText('书架是空的')).toBeVisible()
  await expect(second.page.getByTestId('book-card')).toHaveCount(0)
})
