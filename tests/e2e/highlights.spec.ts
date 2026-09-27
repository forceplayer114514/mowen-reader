import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { expect, test } from '@playwright/test'
import { buildFixturePdf } from '../../scripts/make-fixture-pdf'
import { closeAllApps, enableSelectionStore, importFixture, launch, slowDragSelectInChapter,
  waitForLocationsReady, type Harness } from './helpers'

test.afterEach(closeAllApps)
const marks = (h: Harness) => h.page.locator('g.epubjs-hl-persistent, [data-testid="pdf-highlight-persistent"]')
async function clickMark(h: Harness) {
  const el = marks(h).first()
  const rect = await el.locator('rect').count() ? el.locator('rect').first() : el
  const box = await rect.boundingBox()
  if (!box) throw new Error('高光未渲染')
  await h.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
}

test('荧光笔、橡皮和撤销独立于注释及引用；重排、夜间、收侧栏和重启不丢失', async () => {
  let h = await launch()
  await enableSelectionStore(h)
  await importFixture(h)
  await h.page.getByTestId('book-card').first().click()
  await waitForLocationsReady(h)
  await slowDragSelectInChapter(h)
  await h.page.getByTestId('quote-chip').hover()
  await h.page.getByTestId('quote-annotate').click()
  await h.page.getByTestId('annotation-input').fill('橡皮不能擦掉注释')
  await h.page.getByTestId('annotation-submit').click()
  await expect(h.page.getByTestId('annotation-marker')).toHaveCount(1)
  // Submitting an annotation intentionally consumes that quote; select it again as a chat reference.
  await slowDragSelectInChapter(h)
  await expect(h.page.getByTestId('quote-chip')).toHaveCount(1)
  await h.page.getByTestId('tool-highlight').click()
  await h.page.getByTestId('chat-input').press('Escape')
  await expect(h.page.getByTestId('tool-highlight')).toHaveAttribute('aria-pressed', 'true')
  await slowDragSelectInChapter(h, { clickLandsOnHighlight: false })
  await expect(marks(h)).toHaveCount(1)
  await expect(h.page.getByTestId('quote-chip')).toHaveCount(1)
  await slowDragSelectInChapter(h, { clickLandsOnHighlight: false })
  await expect(marks(h)).toHaveCount(1)
  const before = await h.page.getByTestId('page-indicator').textContent()
  await h.page.getByRole('button', { name: '放大字号' }).click()
  await expect(marks(h)).toHaveCount(1)
  await h.page.getByTestId('toggle-theme').click()
  await expect(marks(h)).toHaveCount(1)
  await h.page.getByRole('button', { name: '收起侧边栏' }).click()
  await expect(marks(h)).toHaveCount(1)
  await h.page.getByRole('button', { name: '展开侧边栏' }).click()
  await h.page.getByTestId('tool-erase').click()
  await clickMark(h)
  await expect(marks(h)).toHaveCount(0)
  await expect(h.page.getByTestId('annotation-marker')).toHaveCount(1)
  await expect(h.page.getByTestId('quote-chip')).toHaveCount(1)
  await h.page.getByTestId('highlight-undo').click()
  await expect(marks(h)).toHaveCount(1)
  await h.page.frameLocator('[data-testid="reader-page"] iframe').first().locator('body').press('Escape')
  await expect(h.page.getByTestId('tool-erase')).toHaveAttribute('aria-pressed', 'false')
  await h.page.getByTestId('quote-chip').click()
  await expect(marks(h)).toHaveCount(1)
  expect(before).toMatch(/页/)
  const userData = h.userData
  await h.app.close()
  h = await launch(userData)
  await h.page.getByTestId('book-card').first().click()
  await waitForLocationsReady(h)
  await expect(marks(h)).toHaveCount(1)
  await expect(h.page.getByTestId('annotation-marker')).toHaveCount(1)
})

for (const format of ['pdf', 'txt'] as const) {
  test(`${format.toUpperCase()} 拖选高光、整条擦除和持久撤销，不新增聊天引用`, async () => {
    const h = await launch()
    const path = join(dirname(h.fixturePath), `highlights.${format}`)
    writeFileSync(path, format === 'pdf' ? buildFixturePdf() : 'Chapter One\n\nThe reader opened the book and began to read.\n\nAnother sentence to test the highlighter and eraser tools.')
    await enableSelectionStore(h)
    await h.page.evaluate((p) => { (window as any).__E2E_FILES__ = [p] }, path)
    await h.page.getByTestId('pick-files').click()
    await h.page.getByTestId('book-card').first().click()
    await waitForLocationsReady(h)
    await h.page.getByTestId('tool-highlight').click()
    if (format === 'txt') await slowDragSelectInChapter(h, { clickLandsOnHighlight: false })
    else await h.page.evaluate(() => {
      const frame = document.querySelector<HTMLIFrameElement>('.pdf-reader__frame')!
      const doc = frame.contentDocument!, win = frame.contentWindow!
      const text = doc.querySelector('.textLayer span')!.firstChild!
      const range = doc.createRange(); range.setStart(text, 0); range.setEnd(text, 10)
      const selection = win.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
      doc.dispatchEvent(new (win as any).MouseEvent('mouseup', { bubbles: true }))
      doc.dispatchEvent(new (win as any).MouseEvent('click', { bubbles: true }))
    })
    await expect(marks(h)).toHaveCount(1)
    await expect(h.page.getByTestId('quote-chip')).toHaveCount(0)
    await h.page.getByTestId('tool-erase').click()
    await clickMark(h)
    await expect(marks(h)).toHaveCount(0)
    await h.page.getByTestId('highlight-undo').click()
    await expect(marks(h)).toHaveCount(1)
    await h.page.getByRole('button', { name: '← 书架' }).click()
    await h.page.getByTestId('book-card').first().click()
    await waitForLocationsReady(h)
    await expect(marks(h)).toHaveCount(1)
  })
}
