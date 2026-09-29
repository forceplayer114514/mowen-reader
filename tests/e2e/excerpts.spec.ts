import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeAllApps, enableSelectionStore, importFixture, launch, slowDragSelectInChapter, waitForLocationsReady } from './helpers'

test.afterEach(closeAllApps)

test('摘录中心按书整理、搜索、定位原文并导出 Markdown', async () => {
  const h = await launch()
  await enableSelectionStore(h)
  await importFixture(h)
  await h.page.getByTestId('book-card').click()
  await waitForLocationsReady(h)
  await slowDragSelectInChapter(h)
  await h.page.getByTestId('quote-chip').hover()
  await h.page.getByTestId('quote-annotate').click()
  await h.page.getByTestId('annotation-input').fill('摘录中心测试笔记')
  await h.page.getByTestId('annotation-submit').click()
  await h.page.getByTestId('tool-highlight').click()
  await slowDragSelectInChapter(h, { clickLandsOnHighlight: false })
  await h.page.getByRole('button', { name: '← 书架' }).click()
  await h.page.getByTestId('open-excerpts').click()
  await expect(h.page.getByTestId('excerpt-book')).toContainText('2 条摘录')
  await h.page.getByTestId('excerpt-book').click()
  await expect(h.page.getByTestId('excerpt-row')).toHaveCount(2)
  await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 600))
  expect(await h.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await h.page.getByTestId('excerpt-search').fill('摘录中心测试笔记')
  await expect(h.page.getByTestId('excerpt-row')).toHaveCount(1)
  const target = join(dirname(h.fixturePath), '摘录中心测试.md')
  await h.app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
  }, target)
  await h.page.getByTestId('excerpt-export').click()
  await expect(h.page.getByTestId('excerpt-export-status')).toContainText('已导出 Markdown')
  const markdown = readFileSync(target, 'utf8')
  expect(markdown).toContain('摘录中心测试笔记')
  expect(markdown).toContain('高亮')
  await h.page.getByRole('button', { name: '回到原文' }).click()
  await waitForLocationsReady(h)
  await expect(h.page.getByTestId('reader-page')).toBeVisible()
})
