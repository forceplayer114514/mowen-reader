import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { buildFixtureEpub } from '../../scripts/make-fixture-epub'

export interface Harness {
  app: ElectronApplication
  page: Page
  userData: string
  fixturePath: string
}

/** 每次启动都用全新的数据目录,测试之间互不影响。传入 userData 可复用上一次的数据。 */
export async function launch(userData?: string): Promise<Harness> {
  const dir = userData ?? mkdtempSync(join(tmpdir(), 'reader-e2e-'))
  const workDir = mkdtempSync(join(tmpdir(), 'reader-e2e-src-'))
  const fixturePath = join(workDir, '测试之书.epub')
  writeFileSync(fixturePath, await buildFixtureEpub())

  const app = await electron.launch({
    args: [resolve('out/main/index.js')],
    env: { ...process.env, READER_USER_DATA: dir, READER_E2E: '1', NODE_ENV: 'test' }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page, userData: dir, fixturePath }
}

export async function importFixture(h: Harness): Promise<void> {
  await h.page.evaluate((p) => {
    ;(window as unknown as { __E2E_FILES__: string[] }).__E2E_FILES__ = [p]
  }, h.fixturePath)
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
