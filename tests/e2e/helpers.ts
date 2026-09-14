import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page
} from '@playwright/test'
import {
  buildBareNavFixtureEpub,
  buildFixtureEpub,
  buildRealisticFixtureEpub
} from '../../scripts/make-fixture-epub'

export interface Harness {
  app: ElectronApplication
  page: Page
  userData: string
  fixturePath: string
  /** 更接近真实排版的样本(嵌套目录、../ 目录链接、封面、插图等,见 fix 1)。 */
  realisticFixturePath: string
  /** 导航文档和章节同目录、目录链接写裸文件名的样本(见 fix 1 第二种真实场景)。 */
  bareNavFixturePath: string
}

// 记录本进程里所有 launch() 启动过、还没关掉的 Electron app,供 closeAllApps()
// 在测试结束时统一收尾——不管测试是正常跑完还是中途断言失败提前退出,都要保证
// 每个启动过的进程和它的临时数据目录不会变成 CI 里的僵尸进程。
const launchedApps: ElectronApplication[] = []

/** 每次启动都用全新的数据目录,测试之间互不影响。传入 userData 可复用上一次的数据。 */
export async function launch(userData?: string): Promise<Harness> {
  const dir = userData ?? mkdtempSync(join(tmpdir(), 'reader-e2e-'))
  const workDir = mkdtempSync(join(tmpdir(), 'reader-e2e-src-'))
  const fixturePath = join(workDir, '测试之书.epub')
  writeFileSync(fixturePath, await buildFixtureEpub())
  const realisticFixturePath = join(workDir, '真实排版测试书.epub')
  writeFileSync(realisticFixturePath, await buildRealisticFixtureEpub())
  const bareNavFixturePath = join(workDir, '裸文件名目录测试书.epub')
  writeFileSync(bareNavFixturePath, await buildBareNavFixtureEpub())

  const app = await electron.launch({
    args: [resolve('out/main/index.js')],
    env: { ...process.env, READER_USER_DATA: dir, READER_E2E: '1', NODE_ENV: 'test' }
  })
  launchedApps.push(app)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page, userData: dir, fixturePath, realisticFixturePath, bareNavFixturePath }
}

/**
 * 关掉这个测试里 launch() 启动过的所有 Electron app,应该在 test.afterEach 里调用。
 * 用 splice 先把数组清空再逐个 close(),这样即使某个 app 之前已经在测试正文里
 * 主动关过(比如"关掉重开"这类需要先关掉前一个实例才能验证持久化的用例),
 * 这里重复调用 close() 也不会把同一个 app 关两次导致状态错乱——而且每个
 * close() 调用本身也用 catch 兜底,已经关闭的 app 再关一次最多是个 no-op
 * 或者抛一个可以安全忽略的错误,不会让收尾逻辑本身失败并掩盖测试的真实结果。
 */
export async function closeAllApps(): Promise<void> {
  const apps = launchedApps.splice(0, launchedApps.length)
  for (const app of apps) {
    await app.close().catch(() => {})
  }
}

export async function importFixture(h: Harness): Promise<void> {
  await h.page.evaluate((p) => {
    ;(window as unknown as { __E2E_FILES__: string[] }).__E2E_FILES__ = [p]
  }, h.fixturePath)
  await h.page.getByTestId('pick-files').click()
  await h.page.getByTestId('book-card').first().waitFor({ timeout: 30_000 })
}

/** 和 importFixture 一样,但导入的是更接近真实排版的样本(见 helpers.ts 顶部注释)。 */
export async function importRealisticFixture(h: Harness): Promise<void> {
  await h.page.evaluate((p) => {
    ;(window as unknown as { __E2E_FILES__: string[] }).__E2E_FILES__ = [p]
  }, h.realisticFixturePath)
  await h.page.getByTestId('pick-files').click()
  await h.page.getByTestId('book-card').first().waitFor({ timeout: 30_000 })
}

/** 和 importFixture 一样,但导入的是导航文档和章节同目录、裸文件名的样本(见 helpers.ts 顶部注释)。 */
export async function importBareNavFixture(h: Harness): Promise<void> {
  await h.page.evaluate((p) => {
    ;(window as unknown as { __E2E_FILES__: string[] }).__E2E_FILES__ = [p]
  }, h.bareNavFixturePath)
  await h.page.getByTestId('pick-files').click()
  await h.page.getByTestId('book-card').first().waitFor({ timeout: 30_000 })
}

/** 等页码索引算完:「正在计算页码…」消失、指示器里出现「页」字。 */
export async function waitForLocationsReady(h: Harness): Promise<void> {
  const indicator = h.page.getByTestId('page-indicator')
  await indicator.waitFor()
  await h.page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="page-indicator"]')
      return !!el && el.textContent !== null && !el.textContent.includes('正在计算')
    },
    { timeout: 60_000 }
  )
}

/**
 * 等页码指示器的文字稳定下来(连续 `stableForMs` 毫秒都没再变过)再返回它最后的
 * 文字。翻页是异步的:epub.js 的翻页要经过 iframe 里的重新排版,再靠一次
 * requestAnimationFrame 驱动的内部队列才会把新位置写回 rendition.location(见
 * src/renderer/reader/engine.ts 对这条队列时序的详细注释),两步都要花掉几十到
 * 几百毫秒——立刻读 textContent() 读到的只是还没翻完时的旧文字。
 */
async function waitForStableText(
  locator: import('@playwright/test').Locator,
  { timeoutMs = 20_000, stableForMs = 800, pollMs = 150 } = {}
): Promise<string> {
  const page = locator.page()
  const deadline = Date.now() + timeoutMs
  let last = (await locator.textContent()) ?? ''
  let lastChangedAt = Date.now()
  while (Date.now() < deadline) {
    await page.waitForTimeout(pollMs)
    const current = (await locator.textContent()) ?? ''
    if (current !== last) {
      last = current
      lastChangedAt = Date.now()
    } else if (Date.now() - lastChangedAt >= stableForMs) {
      return last
    }
  }
  return last
}

/** 等页码指示器的文字稳定下来,返回它最后的文字。见 waitForStableText 的注释。 */
export async function waitForStableIndicator(h: Harness): Promise<string> {
  return waitForStableText(h.page.getByTestId('page-indicator'))
}

/**
 * 一次一次按 `key`,直到页码指示器的文字真的变了(每按一次都等到稳定再看有没有
 * 变),最多按 `maxPresses` 次。返回让文字真正变化所用的按键次数。
 *
 * 内容索引的分段粒度和物理翻页的屏幕粒度不是 1:1 对齐的(见下面 pressAndSettle
 * 的注释),所以不能假设"按一下方向键,页码指示器就一定跟着变"——同一个索引分段
 * 里可能要翻好几屏才会跨到下一段。这里用来验证"往前翻迟早会离开当前页码"这个
 * 更宽松、但更符合实际实现的说法,而不是"按一下必须变"。
 */
export async function pressUntilPageChanges(
  h: Harness,
  key: string,
  maxPresses = 5
): Promise<number> {
  const indicator = h.page.getByTestId('page-indicator')
  const baseline = await indicator.textContent()
  for (let i = 1; i <= maxPresses; i++) {
    await h.page.keyboard.press(key)
    const current = await waitForStableText(indicator)
    if (current !== baseline) return i
  }
  throw new Error(`按了 ${maxPresses} 次「${key}」,页码指示器始终没有变化`)
}

/**
 * 连续按 `times` 次方向键翻页,再等页码指示器稳定下来,返回最终稳定的文字。
 *
 * 页码来自内容索引(每 1000 字符一个分段,见 engine.ts 的 LOCATION_CHUNK),
 * 但每次方向键翻的是排版意义上的一屏——两者的粒度并不对齐:一屏的字数不一定
 * 刚好等于一个分段,所以连续按方向键时,并不能假设「每按一下,索引页码就一定
 * 跟着变一次」——有时候两屏内容才跨过一个分段边界,页码要等第二次翻页才会变。
 * 之前的实现每按一下就断言页码必须变,恰好在这本测试用的样例书里,第 3 段和第 4
 * 段索引之间需要翻两屏才跨过去,断言撞上了这个正常的粒度不对齐,不是应用的缺陷。
 * 这里改成按完所有次数、等指示器不再变化再读值,不对每一次按键单独做假设。
 */
export async function pressAndSettle(
  h: Harness,
  key: string,
  times: number
): Promise<string> {
  const indicator = h.page.getByTestId('page-indicator')
  for (let i = 0; i < times; i++) {
    await h.page.keyboard.press(key)
  }
  return waitForStableText(indicator)
}

/** 一次划选之后,书内容 iframe 里还留着的选中文字;什么都没选中时是空字符串。 */
export async function chapterSelectionText(h: Harness): Promise<string> {
  return h.page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('[data-testid="reader-page"] iframe')
    return frame?.contentWindow?.getSelection()?.toString() ?? ''
  })
}

/** 章节 iframe 带 allow-same-origin,主文档能直接摸到它的 document(epub.js 自己也是这么干的)。 */
const CHAPTER_FRAME = '[data-testid="reader-page"] iframe'

/**
 * 书内容里的一段选区:从第 fromParagraph 段的第 fromOffset 个字,到第 toParagraph
 * 段的第 toOffset 个字。跨段是为了造出一块占好几行的高亮,见 clickChapterHighlight()。
 */
interface ChapterRange {
  fromParagraph: number
  fromOffset: number
  toParagraph: number
  toOffset: number
}

/** 把书内容里这一段设成选中状态。 */
async function selectChapterRange(h: Harness, at: ChapterRange): Promise<void> {
  await h.page.evaluate(
    ({ selector, at }) => {
      const frame = document.querySelector<HTMLIFrameElement>(selector)
      const doc = frame?.contentDocument
      const from = doc?.querySelectorAll('p')[at.fromParagraph]?.firstChild
      const to = doc?.querySelectorAll('p')[at.toParagraph]?.firstChild
      if (!doc || !from || !to) throw new Error('取不到书内容里的段落')
      frame?.contentWindow
        ?.getSelection()
        ?.setBaseAndExtent(from, at.fromOffset, to, at.toOffset)
    },
    { selector: CHAPTER_FRAME, at }
  )
}

/** 章节文档自己的视口坐标系里的一个点。 */
interface ChapterPoint {
  x: number
  y: number
}

/**
 * 量出这一段选区在章节文档里的头尾坐标。
 *
 * 坐标取的是章节文档自己的视口坐标,而不是外层页面的:待会儿派发进去的 MouseEvent
 * 以章节文档为参照,marks-pane 判断"这一下点在哪块矩形里"时也是拿 clientX/clientY
 * 减去 iframe 在外层页面里的位置(node_modules/marks-pane/src/events.js 的 contains),
 * 要的正是章节文档里的坐标。
 */
async function chapterDragPoints(
  h: Harness,
  at: ChapterRange
): Promise<{ start: ChapterPoint; end: ChapterPoint }> {
  return h.page.evaluate(
    ({ selector, at }) => {
      const doc = document.querySelector<HTMLIFrameElement>(selector)?.contentDocument
      const from = doc?.querySelectorAll('p')[at.fromParagraph]?.firstChild
      const to = doc?.querySelectorAll('p')[at.toParagraph]?.firstChild
      if (!doc || !from || !to) throw new Error('取不到书内容里的段落')
      const range = doc.createRange()
      range.setStart(from, at.fromOffset)
      range.setEnd(to, at.toOffset)
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0)
      const first = rects[0]
      const last = rects[rects.length - 1]
      if (!first || !last) throw new Error('量不到这段文字的位置')
      return {
        start: { x: Math.round(first.left + 1), y: Math.round(first.top + first.height / 2) },
        end: { x: Math.round(last.right - 1), y: Math.round(last.top + last.height / 2) }
      }
    },
    { selector: CHAPTER_FRAME, at }
  )
}

/**
 * 往章节文档上派发一次真实的鼠标事件——epub.js 会把它转发到 rendition 上。
 *
 * 派发的目标是坐标下面那个元素,不是 document 本身:真实的鼠标事件是从 document
 * 一路捕获到最里层的元素、再冒泡回 document 的,监听器挂在捕获阶段还是冒泡阶段
 * 会分出先后。直接往 document 上派发的话,整条传播路径只剩 document 一个节点,
 * 先后就没了——而"松手之后补发的那一下 click 会不会被吞掉"恰恰取决于这个先后。
 */
async function dispatchChapterMouse(
  h: Harness,
  type: 'mousedown' | 'mouseup' | 'click',
  at: ChapterPoint
): Promise<void> {
  await h.page.evaluate(
    ({ selector, type, at }) => {
      const doc = document.querySelector<HTMLIFrameElement>(selector)?.contentDocument
      if (!doc) throw new Error('取不到书内容的文档')
      const target = doc.elementFromPoint(at.x, at.y) ?? doc.body
      target.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          view: doc.defaultView,
          clientX: at.x,
          clientY: at.y
        })
      )
    },
    { selector: CHAPTER_FRAME, type, at }
  )
}

/**
 * 在书内容里模拟一次"拖慢了的划选":按下 → 先选中半句 → 停一下 → 选到整句 → 松开。
 *
 * 为什么不用 Playwright 的真鼠标拖动:只要按下鼠标之后指针还落在 sandbox 的 srcdoc
 * iframe 上再 mouse.move,Electron 这边的调试连接会当场断开、窗口跟着关掉,拖动永远
 * 走不完。拿一个跟本应用毫无关系的空白 sandbox iframe 单独试过,一样会断——这是自动化
 * 通道自己的限制,不是阅读器的缺陷,真人用鼠标拖不走这条路。所以改成直接往章节文档上
 * 派发真实的 mousedown/mouseup,中间用 setBaseAndExtent 改选区:选区变化照样触发
 * selectionchange,epub.js 那条 250 毫秒防抖的 selected 事件该来还是会来,引擎这一侧
 * 收到的东西和真人拖选没有区别。
 *
 * 中间那次"只选半句 + 等 400 毫秒"是这个辅助函数的重点:它复现的正是用户拖慢一点、
 * 中途停一下的情形。epub.js 的防抖是从最后一次选区变化算起、不是从松手算起,所以停
 * 这一下就会在鼠标还按着的时候先发一次 selected——"松开才高亮"和"拖到一半就高亮"
 * 两种实现只有在这种拖法下才分得出来。
 *
 * **这个辅助函数能证明什么、不能证明什么**,必须说清楚:
 *
 * 能证明的是——阅读器这一侧从"按下、选区变化、松开、随后补发的那一下 click"这串
 * 事件里得到的结果。事件是真的 MouseEvent、带真实坐标、派发到真实的目标元素上,
 * 走完整条捕获与冒泡路径;选区是用 setBaseAndExtent 改的,照样触发 selectionchange,
 * epub.js 那条 250 毫秒防抖的 selected 事件该来还是会来;marks-pane 的坐标转发也
 * 是按这些坐标真的算了一遍。
 *
 * 不能证明的是——真实指针设备本身的行为。这几个事件是脚本派发的,`isTrusted` 是
 * false,浏览器不会因为它们真的去做原生的拖选(选区是我们自己设的),也不会因为它们
 * 自己补发 click(那一下是我们照真实序列补的)。所以"真实浏览器在这串动作之后一定
 * 会补一次 click"这个前提来自真机上量到的事件日志,不是这里测出来的。
 * 之所以只能这样:按下鼠标后指针还落在 sandbox 的 srcdoc iframe 上再 mouse.move,
 * Electron 的调试连接会当场断开、窗口跟着关掉(见上一段)。
 */
export async function slowDragSelectInChapter(h: Harness, opts: DragOptions = {}): Promise<void> {
  await dragSelectChapterRange(
    h,
    {
      fromParagraph: 1,
      fromOffset: 0,
      toParagraph: 1,
      toOffset: 24
    },
    opts
  )
}

/**
 * 拖选从第 2 段中间一直到第 3 段中间的一片文字,得到的高亮会跨两段、画成好几块
 * 矩形。用来验证"点高亮"在不止一行的高亮上也成立,见 clickChapterHighlight()。
 *
 * 为什么不用"选一段长到折行的话":这本样本书的章节文档在分栏排版下宽到八千多像素,
 * 一整段六十来个字连一行都填不满,靠折行造不出多行高亮;跨段落是同一件事的另一种
 * 造法——两段之间隔着段间距,整块高亮的外接框中心正好落在那条缝里。
 */
export async function dragSelectAcrossParagraphs(
  h: Harness,
  opts: DragOptions = {}
): Promise<void> {
  await dragSelectChapterRange(
    h,
    {
      fromParagraph: 1,
      fromOffset: 4,
      toParagraph: 2,
      toOffset: 20
    },
    opts
  )
}

export interface DragOptions {
  /**
   * 松手之后补发的那一下 click 必须真的落在刚画出来的高亮的某一行矩形里,默认要求。
   * 页面上没有任何人消费划选(画不出高亮)的那条用例传 false。
   */
  clickLandsOnHighlight?: boolean
}

/**
 * 断言这个点真的落在页面上某块高亮的某一行矩形里,不在就当场报错。
 *
 * 为什么非要断言:补发那一下 click 的全部意义在于"它要是没被吞掉,就会落进高亮里
 * 把这次划选取消掉"。没有这一条,坐标算法哪天飘了——比如量到的是另一行、或者偏出
 * 了矩形右边——这一下会静悄悄地打空,吞噬也就没有任何东西可证明,而整套用例照样
 * 全绿:上一轮"十六条全绿、功能是坏的"就是这么来的。
 *
 * 判定照抄 marks-pane 自己的算法(node_modules/marks-pane/src/events.js 的 contains):
 * 矩形的位置是外层页面的坐标,派发进去的点是章节文档自己的坐标,两者靠减掉 iframe
 * 在外层页面里的位置对齐。逐行的矩形要各自比一遍,而不是比整块的外接框——marks-pane
 * 两关都要过,只过外接框那一关的点它并不认。
 *
 * 允许重试几次:marks-pane 的矩形是按正文的 getClientRects() 现算现画的,刚画完那
 * 一瞬间量到的位置不一定是最终位置。
 */
async function assertClickLandsOnHighlight(h: Harness, at: ChapterPoint): Promise<void> {
  let seen: { top: number; left: number; width: number; height: number }[] = []
  for (let i = 0; i < 10; i++) {
    const measured = await h.page.evaluate(
      ({ selector, at }) => {
        const frame = document.querySelector<HTMLIFrameElement>(selector)
        if (!frame) return { ok: false, rects: [] }
        const offset = frame.getBoundingClientRect()
        const rects = Array.from(
          document.querySelectorAll('[data-testid="reader-page"] g.epubjs-hl rect')
        ).map((r) => {
          const b = r.getBoundingClientRect()
          return {
            top: Math.round(b.top - offset.top),
            left: Math.round(b.left - offset.left),
            width: Math.round(b.width),
            height: Math.round(b.height)
          }
        })
        const ok = rects.some(
          (r) =>
            r.top <= at.y &&
            r.left <= at.x &&
            r.top + r.height > at.y &&
            r.left + r.width > at.x
        )
        return { ok, rects }
      },
      { selector: CHAPTER_FRAME, at }
    )
    if (measured.ok) return
    seen = measured.rects
    await h.page.waitForTimeout(100)
  }
  throw new Error(
    `松手那个点 (${at.x}, ${at.y}) 没有落在任何一行高亮矩形里,` +
      `量到的矩形是 ${JSON.stringify(seen)}。` +
      '这一下 click 打空了:它本该正落在刚画出来的高亮上、不被吞掉就会把这次划选取消掉,' +
      '打空之后吞噬没有任何东西可证明,用例却照样会绿。'
  )
}

async function dragSelectChapterRange(
  h: Harness,
  at: ChapterRange,
  opts: DragOptions = {}
): Promise<void> {
  await h.page
    .frameLocator(CHAPTER_FRAME)
    .locator('p')
    .nth(at.toParagraph)
    .waitFor({ timeout: 20_000 })
  const { start, end } = await chapterDragPoints(h, at)
  await dispatchChapterMouse(h, 'mousedown', start)
  // 拖到一半:先只选到起点段落里靠前的位置。
  await selectChapterRange(h, {
    ...at,
    toParagraph: at.fromParagraph,
    toOffset: at.fromOffset + 8
  })
  await h.page.waitForTimeout(400)
  await selectChapterRange(h, at)
  await h.page.waitForTimeout(50)
  await dispatchChapterMouse(h, 'mouseup', end)
  // 补发那一下之前先确认它真的落在刚画出来的高亮里,见 assertClickLandsOnHighlight()。
  if (opts.clickLandsOnHighlight !== false) await assertClickLandsOnHighlight(h, end)
  // 真人拖完一段文字松开鼠标,浏览器紧接着还会在松手那个点上补发一次 click
  // (真机上量到的事件序列就是 mousedown → mouseup → click,三者同一个位置)。
  // 松手那一下已经把这段文字变成了引用、画上了高亮,而补发的这一下正落在这块新
  // 高亮里面——少派发它,"松开即高亮"看起来一切正常,真人用鼠标拖一次却什么都
  // 留不下。这一行就是这个辅助函数里最要紧的一行。
  await dispatchChapterMouse(h, 'click', end)
}

/** 页面上当前画着的划选高亮(marks-pane 盖在正文上的那层 SVG)。 */
export function chapterHighlights(h: Harness): Locator {
  return h.page.locator('[data-testid="reader-page"] g.epubjs-hl')
}

/**
 * 打开书之前置上标记,让阅读界面建一个真的划选 store 订上去(见 ReaderView.tsx 里
 * SelectionTestHooks 的注释)。必须在点开书卡片之前调用——store 是开书那一步建的。
 */
export async function enableSelectionStore(h: Harness): Promise<void> {
  await h.page.evaluate(() => {
    ;(window as unknown as { __E2E_SELECTION__?: boolean }).__E2E_SELECTION__ = true
  })
}

/** 当前划选 store 里的引用列表。需要先 enableSelectionStore()。 */
export async function chapterQuotes(h: Harness): Promise<{ cfiRange: string; text: string }[]> {
  return h.page.evaluate(
    () =>
      (
        window as unknown as { __E2E_QUOTES__?: () => { cfiRange: string; text: string }[] }
      ).__E2E_QUOTES__?.() ?? []
  )
}

/**
 * 点一下页面上那块划选高亮的第 line 行。
 *
 * 高亮那层 SVG 自己是 pointer-events: none 的,marks-pane 是靠监听章节文档里的点击、
 * 再按坐标把事件转发给对应的矩形来实现"点高亮"(见 node_modules/marks-pane/src/events.js
 * 的 proxyMouse),所以要点的是正文上那块地方,而不能去点这个 SVG 元素本身。
 *
 * 瞄的是**其中一行**的矩形,不是整块高亮的外接框中心。marks-pane 判断"这一下算不算
 * 点在这块高亮上"是先看外接框、再逐个看每一行的矩形(events.js 的 contains),两关
 * 都得过。一段话只占一行时外接框中心当然在那一行里;一旦这段话折了行,外接框就
 * 罩住了整片区域,它的中心很可能落在两行之间的行距里——外接框那一关过了,逐行那
 * 一关过不了,点下去什么也不会发生,而失败原因看上去会像是"取消高亮坏了"。
 *
 * 点之前先停一下:marks-pane 的矩形是按正文的 getClientRects() 现算现画的,刚画完那
 * 一瞬间量到的位置不一定是最终位置。
 */
export async function clickChapterHighlight(h: Harness, line = 0): Promise<void> {
  await h.page.waitForTimeout(200)
  const box = await chapterHighlights(h).first().locator('rect').nth(line).boundingBox()
  if (!box || box.width < 1 || box.height < 1) throw new Error('取不到高亮那一行的位置')
  await h.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
}

/** 页面上第一块划选高亮占了几行(marks-pane 每行画一个 rect)。 */
export async function chapterHighlightLines(h: Harness): Promise<number> {
  return chapterHighlights(h).first().locator('rect').count()
}
