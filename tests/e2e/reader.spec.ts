import { expect, test } from '@playwright/test'
import {
  chapterHighlightLines,
  chapterHighlights,
  chapterQuotes,
  chapterSelectionText,
  clickChapterHighlight,
  closeAllApps,
  enableSelectionStore,
  importBareNavFixture,
  importFixture,
  importRealisticFixture,
  launch,
  dragSelectAcrossParagraphs,
  slowDragSelectInChapter,
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

test('裸文件名样本:导航文档和章节同目录、链接不带任何前缀,页脚仍能显示章节名、目录跳转仍然生效', async () => {
  const h = await launch()
  await importBareNavFixture(h)
  await h.page.getByTestId('book-card').first().click()
  await h.page.getByTestId('reader-page').waitFor()

  // 这本样本的目录(EPUB 3 nav)和它链接的章节放在同一目录下,链接直接写裸文件名
  // "ch1.xhtml",不带任何前缀——跟真实排版样本里 "../Text/ch1.xhtml" 那种字符串
  // 形态完全不同。只把 "."/".." 段拿掉的归一化对这种写法没用,必须先把 href
  // 解析到导航文档自己的目录下才能跟 spine 报告的 "Text/ch1.xhtml" 对上
  // (见 href.ts 的 resolveNavigationHref())。
  await expect(h.page.getByTestId('reader-foot')).toContainText('第一章 起点', {
    timeout: 20_000
  })

  await h.page.getByTestId('toggle-toc').click()
  const toc = h.page.getByTestId('toc')
  await expect(toc.getByText('第一章 起点')).toBeVisible()
  await expect(toc.getByText('第三章 终点')).toBeVisible()

  // 点目录里的第二章:如果解析不出章节,epub.js 会用 "No Section Found" 拒绝
  // display() 这个 promise,界面上什么反应都不会发生——这里断言真的跳转过去了。
  await toc.getByText('第二章 中途').click()
  await expect(h.page.getByTestId('reader-foot')).toContainText('第二章 中途', {
    timeout: 20_000
  })
})

test('真实排版样本:书架上渲染的是封面图,不是标题文字兜底', async () => {
  const h = await launch()
  await importRealisticFixture(h)

  // 简单样本没有封面,书架用书名文字兜底(见 LibraryView.tsx 的注释),两处文字
  // 相同是有意的设计。这本样本内嵌了封面图,提取 -> 经 IPC 传输 -> 写文件 ->
  // 读回来 -> 渲染,整条链路第一次真正跑起来——之前没有任何样本带封面,这条
  // 链路只有中间“写文件”那一步有单元测试覆盖过。
  const cover = h.page.locator('.book-card__cover').first()
  await expect(cover.locator('img')).toBeVisible({ timeout: 15_000 })
  await expect(cover).not.toHaveText('真实排版测试书')
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

// --- 以下覆盖划选与高亮(Task 8):这四条只能在真实 EPUB + 真实 iframe 里跑,
// 单元测试那边的假引擎碰不到 epub.js 的选区、标注和 marks-pane。 ---

test('没有人消费划选时,拖选出来的文字不会被清掉', async () => {
  const h = await launch()
  await importFixture(h)
  await h.page.getByTestId('book-card').first().click()
  await h.page.getByTestId('reader-page').waitFor()
  await waitForLocationsReady(h)

  // 这条用例里没有任何人消费划选,画不出高亮,所以不要求补发的那一下落在高亮里。
  await slowDragSelectInChapter(h, { clickLandsOnHighlight: false })
  // epub.js 那边的防抖是 250 毫秒,等得比它久,确保"到点之后会不会被清掉"已经发生过。
  await h.page.waitForTimeout(800)

  expect(
    (await chapterSelectionText(h)).trim().length,
    '侧边栏还没接进来,页面上没有任何人订阅划选;这时候把浏览器选区清掉,用户拖选一段话只会看到它自己消失,连复制都做不到'
  ).toBeGreaterThan(0)
})

test('一次拖选只留下一段引用和一块高亮——中途停住也不会变成两段', async () => {
  const h = await launch()
  await importFixture(h)
  await enableSelectionStore(h)
  await h.page.getByTestId('book-card').first().click()
  await h.page.getByTestId('reader-page').waitFor()
  await waitForLocationsReady(h)

  await slowDragSelectInChapter(h)
  // epub.js 的 selected 是从最后一次选区变化起算 250 毫秒,等够久让"松手之后还会不会
  // 再补一段"这件事有机会发生,否则第二段还没冒出来就断言,红不了也说明不了问题。
  await h.page.waitForTimeout(1200)

  expect(
    await chapterQuotes(h),
    '拖到一半停住会让 epub.js 在鼠标还按着的时候先发一次 selected,如果那一次就当成了一次划选,松手后的完整范围会再进来一段,两段文字一长一短、互相重叠'
  ).toHaveLength(1)
  await expect(chapterHighlights(h)).toHaveCount(1)
})

test('松手之后浏览器补发的那一下 click 不会把刚画出来的高亮连同引用一起抹掉', async () => {
  const h = await launch()
  await importFixture(h)
  await enableSelectionStore(h)
  await h.page.getByTestId('book-card').first().click()
  await h.page.getByTestId('reader-page').waitFor()
  await waitForLocationsReady(h)

  // slowDragSelectInChapter 的最后一步就是在松手那个点上补发一次 click ——
  // 真人拖选之后浏览器一定会补这一下。
  await slowDragSelectInChapter(h)

  expect(
    await chapterQuotes(h),
    '松手那一刻已经把这段文字变成引用、在同一片文字上画好了高亮,紧跟着补发的那一下 click 正落在这块新高亮里;marks-pane 按坐标把它转给高亮矩形,矩形上挂的正是「点它就取消」的回调,于是每一次普通的拖选都是画出来又立刻被自己抹掉'
  ).toHaveLength(1)
  await expect(chapterHighlights(h)).toHaveCount(1)

  // 吞掉的必须只有紧跟着的那一下。过一会儿真去点这块高亮,它还得取消得掉——
  // 否则"不被自己抹掉"就变成了"永远点不掉"。
  await clickChapterHighlight(h)
  await expect(chapterHighlights(h)).toHaveCount(0)
  expect(await chapterQuotes(h)).toHaveLength(0)
})

test('页面上已经有一块高亮之后再拖选一次,新画出来的那块同样不会被补发的 click 抹掉', async () => {
  const h = await launch()
  await importFixture(h)
  await enableSelectionStore(h)
  await h.page.getByTestId('book-card').first().click()
  await h.page.getByTestId('reader-page').waitFor()
  await waitForLocationsReady(h)

  // 第一次拖选。marks-pane 的那层转发是画第一块高亮的时候才挂到章节文档上的
  // (epub.js 的 IframeView.highlight() 里 pane 是懒建的),在这之前它根本不存在。
  await slowDragSelectInChapter(h)
  await expect(chapterHighlights(h)).toHaveCount(1)

  // 第二次拖选另一片文字。**这一次才真正分得出捕获阶段和注册顺序**:marks-pane 的
  // 转发早就挂在文档上了,而引擎那份吞噬是在这一次松手时才挂上去的,注册顺序排在
  // 它后面。引擎要是挂在冒泡阶段,谁先注册谁先跑,marks-pane 会先收到补发的这一下
  // click,按坐标转给刚画出来的那块高亮,把它连同引用一起取消掉;挂在捕获阶段,
  // document 的捕获排在整条传播路径最前面,和注册顺序无关,引擎才稳赢。
  // 第一次拖选那几条用例证不到这一点:那时候引擎的监听本来就是文档上唯一的一个,
  // 换成冒泡阶段照样全绿。
  await dragSelectAcrossParagraphs(h)

  expect(
    await chapterQuotes(h),
    '页面上已经有高亮时,marks-pane 的转发比引擎的吞噬先注册;只有挂在捕获阶段才轮得到引擎先处理这一下 click,否则第二次拖选画出来就被自己抹掉'
  ).toHaveLength(2)
  await expect(chapterHighlights(h)).toHaveCount(2)
})

test('拖选一句话会画出高亮,点一下这块高亮就取消掉', async () => {
  const h = await launch()
  await importFixture(h)
  await enableSelectionStore(h)
  await h.page.getByTestId('book-card').first().click()
  await h.page.getByTestId('reader-page').waitFor()
  await waitForLocationsReady(h)

  await slowDragSelectInChapter(h)

  const highlight = chapterHighlights(h)
  await expect(highlight).toHaveCount(1)
  expect((await chapterQuotes(h))[0]?.text).toBe('开端的第2段。这是一段用于测试分页与划选的正文,')
  // 配色是画在 <g> 元素的属性上的(marks-pane 把传进去的 styles 原样 setAttribute
  // 到这个元素上),不是给文字加背景色。
  await expect(highlight).toHaveAttribute('fill', '#f2c14e')
  // 选区被收走了,原生的蓝色选中块不会再压在自定义高亮上面。
  expect(await chapterSelectionText(h)).toBe('')

  await clickChapterHighlight(h)

  await expect(highlight).toHaveCount(0)
  expect(await chapterQuotes(h)).toHaveLength(0)
})

test('划选跨两段的一片文字,高亮画成好几块矩形,点其中一块照样取消得掉', async () => {
  const h = await launch()
  await importFixture(h)
  await enableSelectionStore(h)
  await h.page.getByTestId('book-card').first().click()
  await h.page.getByTestId('reader-page').waitFor()
  await waitForLocationsReady(h)

  await dragSelectAcrossParagraphs(h)
  await expect(chapterHighlights(h)).toHaveCount(1)

  // marks-pane 每行画一个矩形(marks.js 的 Highlight.render 遍历 getClientRects),
  // 跨了段就不止一个。这一条同时钉住了辅助函数瞄的是哪儿:它必须瞄其中一行的矩形,
  // 而不是整块高亮的外接框中心——后者在不止一行的高亮上会落在两行之间的缝里,
  // marks-pane 逐行那一关过不了,点下去什么也不会发生,看上去却像是"取消高亮坏了"。
  expect(await chapterHighlightLines(h)).toBeGreaterThan(1)

  await clickChapterHighlight(h, 1)

  await expect(chapterHighlights(h)).toHaveCount(0)
  expect(await chapterQuotes(h)).toHaveLength(0)
})

test('换主题时高亮按新配色重画,既不消失也不会叠成两块,点一下照样取消得掉', async () => {
  const h = await launch()
  await importFixture(h)
  await enableSelectionStore(h)
  await h.page.getByTestId('book-card').first().click()
  await h.page.getByTestId('reader-page').waitFor()
  await waitForLocationsReady(h)

  await slowDragSelectInChapter(h)
  const highlight = chapterHighlights(h)
  await expect(highlight).toHaveCount(1)
  await expect(highlight).toHaveAttribute('fill', '#f2c14e')

  await h.page.getByRole('button', { name: '夜间' }).click()
  await expect(h.page.getByRole('button', { name: '日间' })).toBeVisible()

  // 高亮的配色是创建那一刻写死在 SVG 属性上的,不会跟着主题走。浅色那块正片叠底的
  // 黄色落到夜间的深色背景上会被压得几乎看不见——用户选了几句话顺手点了「夜间」,
  // 选中标记就没了,但引用其实还在列表里。所以换主题要按新配色重画一遍,而且只能
  // 有一块:重画前没把旧的那层抹掉的话,marks-pane 上会留下一层再也摸不到的矩形。
  await expect(highlight).toHaveCount(1)
  await expect(highlight).toHaveAttribute('fill', '#7aa2f7')
  expect(await chapterQuotes(h)).toHaveLength(1)

  // 重画必须把原来的点击回调原样再传进去,否则重画出来的高亮点了不取消。
  await clickChapterHighlight(h)
  await expect(highlight).toHaveCount(0)
  expect(await chapterQuotes(h)).toHaveLength(0)
})
