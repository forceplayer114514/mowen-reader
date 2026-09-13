import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { buildFixtureEpub, buildRealisticFixtureEpub } from '../../scripts/make-fixture-epub'

export interface Harness {
  app: ElectronApplication
  page: Page
  userData: string
  fixturePath: string
  /** 更接近真实排版的样本(嵌套目录、../ 目录链接、封面、插图等,见 fix 1)。 */
  realisticFixturePath: string
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

  const app = await electron.launch({
    args: [resolve('out/main/index.js')],
    env: { ...process.env, READER_USER_DATA: dir, READER_E2E: '1', NODE_ENV: 'test' }
  })
  launchedApps.push(app)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page, userData: dir, fixturePath, realisticFixturePath }
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
