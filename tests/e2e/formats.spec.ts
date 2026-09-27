import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { expect, test } from '@playwright/test'
import { buildFixturePdf } from '../../scripts/make-fixture-pdf'
import { closeAllApps, launch, enableSelectionStore, waitForLocationsReady, type Harness } from './helpers'

test.afterEach(closeAllApps)

async function importPath(h: Harness, path: string): Promise<void> {
  await h.page.evaluate((p) => { (window as any).__E2E_FILES__ = [p] }, path)
  await h.page.getByTestId('pick-files').click()
  await expect(h.page.getByTestId('book-card')).toHaveCount(1)
}

test('PDF text selection, notes, fixed page counts, outlines and restart persistence', async () => {
  let h = await launch()
  const path = join(dirname(h.fixturePath), '测试.pdf')
  writeFileSync(path, buildFixturePdf())
  await enableSelectionStore(h)
  await importPath(h, path)
  await expect(h.page.getByTestId('book-card')).toContainText('PDF Reading Test')
  await h.page.getByTestId('book-card').click()
  await waitForLocationsReady(h)
  await expect(h.page.getByTestId('page-indicator')).toHaveText('第 1 / 3 页')
  await expect(h.page.frameLocator('.pdf-reader__frame').locator('.textLayer')).toContainText('First page text')
  await h.page.getByRole('button', { name: '放大 PDF', exact: true }).click()
  await expect(h.page.getByTestId('font-size')).toHaveText('111%')
  await expect(h.page.getByTestId('page-indicator')).toHaveText('第 1 / 3 页')
  await h.page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('.pdf-reader__frame')!
    const doc = frame.contentDocument!, win = frame.contentWindow!
    const node = doc.querySelector('.textLayer span')!.firstChild!
    const range = doc.createRange(); range.setStart(node, 0); range.setEnd(node, 10)
    const selection = win.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    doc.dispatchEvent(new (win as any).MouseEvent('mouseup', { bubbles: true, button: 0 }))
    doc.dispatchEvent(new (win as any).MouseEvent('click', { bubbles: true, button: 0 }))
  })
  await expect(h.page.getByTestId('quote-chip')).toContainText('PDF Readin')
  await expect(h.page.getByTestId('pdf-highlight')).toHaveCount(1)
  await h.page.getByTestId('quote-chip').hover()
  await h.page.getByTestId('quote-annotate').click()
  await h.page.getByTestId('annotation-input').fill('PDF 注释不会改变原页数')
  await h.page.getByTestId('annotation-submit').click()
  await expect(h.page.getByTestId('annotation-marker')).toHaveCount(1)
  await expect(h.page.getByTestId('annotation-underline')).toHaveCount(1)
  await h.page.getByRole('button', { name: '收起侧边栏' }).click()
  await expect(h.page.locator('.pdf-reader__frame')).toHaveCount(1)
  await expect(h.page.getByTestId('annotation-marker')).toHaveCount(1)
  await h.page.getByRole('button', { name: '展开侧边栏' }).click()
  await h.page.getByTestId('toggle-theme').click()
  await expect.poll(() => h.page.evaluate(() => document.querySelector<HTMLIFrameElement>('.pdf-reader__frame')?.contentDocument?.documentElement.classList.contains('dark'))).toBe(true)
  await h.page.getByTestId('toggle-toc').click()
  await h.page.getByRole('button', { name: 'Second chapter', exact: true }).click()
  await expect(h.page.getByTestId('page-indicator')).toHaveText('第 2 / 3 页')
  await h.page.getByTestId('bookmark-toggle').click()
  await expect(h.page.getByTestId('bookmark-toggle')).toContainText('已加书签')
  await expect.poll(() => h.page.evaluate(async () => (await window.api.listBooks())[0].lastReadCfi)).toContain('[pdf-page-2]')
  const profile = h.userData
  await h.app.close()
  h = await launch(profile)
  await enableSelectionStore(h)
  await h.page.getByTestId('book-card').click()
  await expect(h.page.getByTestId('page-indicator')).toHaveText('第 2 / 3 页')
  await expect(h.page.getByTestId('bookmark-toggle')).toContainText('已加书签')
  expect(await h.page.evaluate(async () => { const [b] = await window.api.listBooks(); return (await window.api.listAnnotations(b.id)).length })).toBe(1)
  await h.page.getByRole('button', { name: '下一页', exact: true }).click()
  await expect(h.page.getByTestId('page-indicator')).toHaveText('第 3 / 3 页')
  await expect(h.page.getByTestId('reader-foot')).toContainText('暂不支持 OCR')
})

test('TXT uses EPUB pagination/selection and preserves original format on restart', async () => {
  let h = await launch()
  const path = join(dirname(h.fixturePath), '中文文本.TXT')
  writeFileSync(path, `第一章 开始\n${Array.from({ length: 100 }, (_, i) => `第 ${i} 段：这是一段用于测试文本书籍分页与阅读位置的中文。`.repeat(6)).join('\n')}\n第二章 结束\n最后一段。`)
  await enableSelectionStore(h)
  await importPath(h, path)
  await expect(h.page.getByTestId('book-card')).toContainText('中文文本')
  await h.page.getByTestId('book-card').click()
  await waitForLocationsReady(h)
  const initial = await h.page.getByTestId('page-indicator').textContent()
  await h.page.getByRole('button', { name: '放大字号' }).click()
  await expect.poll(() => h.page.getByTestId('page-indicator').textContent()).not.toBe(initial)
  await h.page.getByRole('button', { name: '下一页', exact: true }).click()
  await h.page.getByTestId('bookmark-toggle').click()
  const profile = h.userData
  await expect.poll(() => h.page.evaluate(async () => (await window.api.listBooks())[0].lastReadCfi)).toContain('epubcfi(')
  await h.app.close()
  h = await launch(profile)
  await h.page.getByTestId('book-card').click()
  await waitForLocationsReady(h)
  await expect(h.page.getByTestId('bookmark-toggle')).toContainText('已加书签')
  expect(await h.page.evaluate(async () => (await window.api.listBooks())[0].filePath)).toMatch(/\.txt$/)
})

test('bad PDF and binary/empty TXT are rejected without leaving broken books', async () => {
  const h = await launch()
  for (const [name, bytes] of [['坏.pdf', 'not a pdf'], ['二进制.txt', '\u0000secret'], ['空.txt', '  \n']]) {
    const path = join(dirname(h.fixturePath), name)
    writeFileSync(path, bytes)
    await h.page.evaluate((p) => { (window as any).__E2E_FILES__ = [p] }, path)
    await h.page.getByTestId('pick-files').click()
    await expect(h.page.locator('.library__notice--error')).toBeVisible()
    await expect(h.page.getByTestId('book-card')).toHaveCount(0)
  }
})
