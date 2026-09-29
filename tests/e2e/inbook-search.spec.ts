import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { expect, test } from '@playwright/test'
import { buildFixturePdf } from '../../scripts/make-fixture-pdf'
import { closeAllApps, importFixture, launch, waitForLocationsReady } from './helpers'

test.afterEach(closeAllApps)

test('EPUB 全书搜索可跨章节跳转，书内快捷键能打开搜索', async () => {
  const h = await launch()
  await importFixture(h)
  await h.page.getByTestId('book-card').click()
  await waitForLocationsReady(h)
  await h.page.getByTestId('toggle-search').click()
  await h.page.getByTestId('inbook-search-input').fill('归途的第60段')
  await expect(h.page.getByTestId('inbook-search-result').first()).toBeVisible({ timeout: 20_000 })
  await h.page.getByTestId('inbook-search-result').first().click()
  await expect(h.page.getByTestId('reader-foot')).toContainText('第三章 归途')
  await h.page.getByTestId('inbook-search-close').click()
  await h.page.evaluate(() => {
    const doc = document.querySelector<HTMLIFrameElement>('.reader__page iframe')?.contentDocument
    if (doc) doc.dispatchEvent(new (doc.defaultView as any).KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true }))
  })
  await expect(h.page.getByTestId('inbook-search-input')).toBeVisible()
})

test('PDF 搜索文本层并跳到实际页码，扫描页没有伪命中', async () => {
  const h = await launch()
  const path = join(dirname(h.fixturePath), '搜索测试.pdf')
  writeFileSync(path, buildFixturePdf())
  await h.page.evaluate(p => { (window as any).__E2E_FILES__ = [p] }, path)
  await h.page.getByTestId('pick-files').click()
  await h.page.getByTestId('book-card').click()
  await waitForLocationsReady(h)
  await h.page.getByTestId('toggle-search').click()
  await h.page.getByTestId('inbook-search-input').fill('Second page restores')
  await expect(h.page.getByTestId('inbook-search-result')).toHaveCount(1)
  await h.page.getByTestId('inbook-search-result').click()
  await expect(h.page.getByTestId('page-indicator')).toHaveText('第 2 / 3 页')
  await h.page.getByTestId('inbook-search-input').fill('image-only page')
  await expect(h.page.getByTestId('inbook-search-count')).toHaveText('无结果')
})
