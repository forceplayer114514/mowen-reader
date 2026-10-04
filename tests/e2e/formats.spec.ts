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

/** Check the compositor output, not just canvas backing pixels (which can be valid but invisible). */
async function displayedPdfPixel(h: Harness): Promise<number[]> {
  const point = await h.page.evaluate(() => {
    const frame = Array.from(document.querySelectorAll<HTMLIFrameElement>('.pdf-reader__frame'))
      .find(item => item.style.visibility !== 'hidden')!
    const page = frame.contentDocument!.querySelector('.page')!.getBoundingClientRect()
    const host = frame.getBoundingClientRect()
    return { x: Math.floor(host.x + page.x + page.width / 2), y: Math.floor(host.y + page.y + page.height / 2) }
  })
  const png = (await h.page.screenshot({ scale: 'css', animations: 'disabled' })).toString('base64')
  return h.page.evaluate(async ({ png, point }) => {
    const image = new Image()
    image.src = `data:image/png;base64,${png}`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
    const context = canvas.getContext('2d')!
    context.drawImage(image, 0, 0)
    return Array.from(context.getImageData(point.x, point.y, 1, 1).data).slice(0, 3)
  }, { png, point })
}

async function expectDisplayedPdfPixel(h: Harness, rgb: number[]): Promise<void> {
  // OS display profiles can shift screenshot RGB; a blank paper surface is nowhere near this blue.
  await expect.poll(async () => (await displayedPdfPixel(h))
    .every((value, index) => Math.abs(value - rgb[index]) < 30)).toBe(true)
}

test('PDF original-layout controls preserve page, viewport and separate EPUB font settings', async () => {
  const h = await launch()
  const path = join(dirname(h.fixturePath), '原版阅读.pdf')
  writeFileSync(path, buildFixturePdf())
  await importPath(h, path)
  await h.page.evaluate(() => window.api.setSetting('fontSize', '26'))
  await h.page.getByTestId('book-card').click()
  await expect(h.page.getByTestId('pdf-view-controls')).toBeVisible()
  await expect(h.page.getByTestId('toggle-typography')).toHaveCount(0)
  await expect(h.page.getByTestId('font-size')).toHaveCount(0)
  await h.page.getByRole('button', { name: '适合宽度', exact: true }).click()
  await expect(h.page.getByRole('button', { name: '适合宽度', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await h.page.getByTestId('pdf-scale').selectOption('2')
  const geometry = () => h.page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('.pdf-reader__frame')!
    const win = frame.contentWindow!, rect = frame.contentDocument!.querySelector('.page')!.getBoundingClientRect()
    return { width: rect.width, x: (win.innerWidth / 2 - rect.left) / rect.width,
      y: (win.innerHeight / 2 - rect.top) / rect.height, scrollX: win.scrollX, scrollY: win.scrollY }
  })
  await expect.poll(async () => (await geometry()).width).toBeCloseTo(1200, 0)
  await h.page.evaluate(() => document.querySelector<HTMLIFrameElement>('.pdf-reader__frame')!.contentWindow!.scrollTo(280, 400))
  const before = await geometry()
  await h.page.getByRole('button', { name: '放大 PDF', exact: true }).click()
  await expect.poll(async () => (await geometry()).width).toBeCloseTo(1350, 0)
  const zoomed = await geometry()
  expect(zoomed.x).toBeCloseTo(before.x, 2)
  expect(zoomed.y).toBeCloseTo(before.y, 2)
  const beforeResize = await h.page.locator('.pdf-reader__frame:visible').elementHandle()
  await h.page.getByRole('button', { name: '收起侧边栏' }).click()
  // Geometry can briefly match the old frame before React applies the sidebar resize.
  await expect.poll(() => beforeResize!.evaluate(frame => frame.isConnected)).toBe(false)
  await beforeResize!.dispose()
  await expect(h.page.locator('.pdf-reader__frame')).toHaveCount(1)
  await expect.poll(async () => (await geometry()).width).toBeCloseTo(1350, 0)
  await expect.poll(async () => (await geometry()).x).toBeCloseTo(before.x, 2)
  await expect.poll(async () => (await geometry()).y).toBeCloseTo(before.y, 2)
  await h.page.getByTestId('tool-pan').click()
  await expect(h.page.getByTestId('tool-pan')).toHaveAttribute('aria-pressed', 'true')
  // Snapshot atomically: resizing can replace the visible iframe between locator resolution and boundingBox().
  const frameBox = await h.page.evaluate(() => {
    const frame = Array.from(document.querySelectorAll<HTMLIFrameElement>('.pdf-reader__frame'))
      .find((item) => item.style.visibility !== 'hidden')!
    const rect = frame.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  })
  const scrolled = await geometry()
  // Playwright's drag detector waits on an iframe timer; sandboxed pages disallow scripts.
  // Send real browser pointer input directly, retaining pointer capture and scroll verification.
  const input = await h.page.context().newCDPSession(h.page)
  const x = frameBox.x + frameBox.width / 2, y = frameBox.y + frameBox.height / 2
  await input.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await input.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  for (let step = 1; step <= 10; step++) {
    await input.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: y - step * 10, button: 'left', buttons: 1 })
  }
  await input.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y: y - 100, button: 'left', buttons: 0, clickCount: 1 })
  await input.detach()
  await expect.poll(async () => (await geometry()).scrollY).toBeGreaterThan(scrolled.scrollY + 90)
  await h.page.keyboard.press('Escape')
  await expect(h.page.getByTestId('tool-pan')).toHaveAttribute('aria-pressed', 'false')
  await expect(h.page.getByTestId('page-indicator')).toHaveText('第 1 / 3 页')
  expect(await h.page.evaluate(() => window.api.getSetting('fontSize'))).toBe('26')
  await expect.poll(() => h.page.evaluate(() => window.api.getSetting('pdfView'))).toContain('2.25')
  await h.page.getByRole('button', { name: '← 书架', exact: true }).click()
  await h.page.getByTestId('book-card').click()
  await expect(h.page.getByTestId('pdf-scale')).toHaveValue('2.25')
  await expect(h.page.getByTestId('page-indicator')).toHaveText('第 1 / 3 页')
  await h.page.getByRole('button', { name: '适合整页', exact: true }).click()
  await expect(h.page.getByRole('button', { name: '适合整页', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => (await geometry()).scrollY).toBe(0)
  await h.page.getByTestId('pdf-scale').selectOption('1')
  await expect.poll(async () => (await geometry()).width).toBeCloseTo(600, 0)
  // Same-frame clicks model a slow scan render: each step must contribute, not repeat the stale scale.
  await h.page.evaluate(() => {
    const plus = document.querySelector<HTMLButtonElement>('[aria-label="放大 PDF"]')!
    plus.click(); plus.click(); plus.click()
  })
  await expect(h.page.getByTestId('pdf-scale')).toHaveValue('1.75')
  await h.page.getByRole('button', { name: '适合整页', exact: true }).click()
  await h.page.getByTestId('pdf-scale').focus()
  await h.page.keyboard.press('PageDown')
  await expect(h.page.getByTestId('page-indicator')).toHaveText('第 1 / 3 页')
  await h.page.getByRole('button', { name: '适合整页', exact: true }).click()
  await h.page.screenshot({ path: test.info().outputPath('pdf-original-light.png'), animations: 'disabled' })
  await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 600))
  await expect.poll(() => h.page.evaluate(() => window.innerWidth)).toBe(900)
  for (const control of ['pdf-scale', 'tool-pan', 'page-indicator']) {
    await expect(h.page.getByTestId(control)).toBeInViewport()
  }
  const bounds = await h.page.getByTestId('pdf-view-controls').boundingBox()
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(900)
  await h.page.screenshot({ path: test.info().outputPath('pdf-original-minimum.png'), animations: 'disabled' })
})

test('image-only PDF keeps navigation and bookmarks available without pretending text tools work', async () => {
  const h = await launch()
  const path = join(dirname(h.fixturePath), '扫描阅读.pdf')
  writeFileSync(path, buildFixturePdf())
  await enableSelectionStore(h)
  await importPath(h, path)
  await h.page.getByTestId('book-card').click()
  await waitForLocationsReady(h)
  await h.page.getByRole('spinbutton', { name: 'PDF 跳转页码' }).fill('3')
  await h.page.getByRole('button', { name: '前往', exact: true }).click()
  await expect(h.page.getByTestId('pdf-scan-notice')).toContainText('没有文字层')
  await expect(h.page.getByTestId('tool-highlight')).toBeDisabled()
  await expect(h.page.getByTestId('read-aloud-toggle')).toBeDisabled()
  await expect(h.page.getByTestId('tool-pan')).toBeEnabled()
  await h.page.getByTestId('bookmark-toggle').click()
  await expect(h.page.getByTestId('bookmark-toggle')).toContainText('已加书签')
  await expectDisplayedPdfPixel(h, [51, 128, 178])
  const lightPixel = await displayedPdfPixel(h)
  await h.page.screenshot({ path: test.info().outputPath('pdf-scan-light.png'), animations: 'disabled' })
  await h.page.getByTestId('toggle-theme').click()
  await expect.poll(() => h.page.evaluate(() => document.querySelector<HTMLIFrameElement>('.pdf-reader__frame')!.contentDocument!.documentElement.classList.contains('dark'))).toBe(true)
  await expectDisplayedPdfPixel(h, [86, 148, 188])
  await expect.poll(async () => (await displayedPdfPixel(h))
    .some((value, index) => Math.abs(value - lightPixel[index]) > 15)).toBe(true)
  await h.page.screenshot({ path: test.info().outputPath('pdf-scan-dark.png'), animations: 'disabled' })
  await h.page.getByRole('button', { name: '适合宽度', exact: true }).click()
  await h.page.getByRole('button', { name: '收起侧边栏' }).click()
  await expect(h.page.getByTestId('page-indicator')).toHaveText('第 3 / 3 页')
  await h.page.getByRole('button', { name: '上一页', exact: true }).click()
  await expect(h.page.getByTestId('page-indicator')).toHaveText('第 2 / 3 页')
  await expect(h.page.getByTestId('pdf-scan-notice')).toHaveCount(0)
  await expect(h.page.getByTestId('tool-highlight')).toBeEnabled()
  await expect(h.page.getByTestId('read-aloud-toggle')).toBeEnabled()
  await h.page.getByRole('button', { name: '下一页', exact: true }).click()
  await expect(h.page.getByTestId('page-indicator')).toHaveText('第 3 / 3 页')
  await h.page.getByTestId('toggle-theme').click()
  await h.page.getByRole('button', { name: '适合整页', exact: true }).click()
  await expectDisplayedPdfPixel(h, [51, 128, 178])
})

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
  await expect(h.page.getByTestId('pdf-scale')).toBeEnabled()
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
  await h.page.getByTestId('pdf-scale').selectOption('4')
  await expect(h.page.getByTestId('pdf-scale')).toHaveValue('4')
  await h.page.getByTestId('sidebar-tab-annotations').click()
  await h.page.getByTestId('annotation-locate').click()
  await expect.poll(() => h.page.evaluate(() => document.querySelector<HTMLIFrameElement>('.pdf-reader__frame')!.contentWindow!.scrollY)).toBeGreaterThan(0)
  await expect(h.page.getByTestId('page-indicator')).toHaveText('第 1 / 3 页')
  await h.page.getByRole('button', { name: '适合整页', exact: true }).click()
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
  await expect(h.page.getByTestId('pdf-scan-notice')).toContainText('拖选')
  await expect(h.page.getByTestId('pdf-ocr-page')).toHaveCount(0)
  await expect(h.page.getByTestId('pdf-ocr-region')).toHaveCount(0)
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
