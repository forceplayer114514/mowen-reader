import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { expect, test } from '@playwright/test'
import { buildFixturePdf } from '../../scripts/make-fixture-pdf'
import { closeAllApps, enableSelectionStore, launch, waitForLocationsReady, type Harness } from './helpers'

test.afterEach(closeAllApps)

async function openScan(h: Harness): Promise<string> {
  // Install before opening the book: automatic hover must never download models
  // during renderer regression tests.
  await mockRecognizer(h)
  const path = join(dirname(h.fixturePath), '按需识别.pdf')
  writeFileSync(path, buildFixturePdf())
  await h.page.evaluate(p => { (window as any).__E2E_FILES__ = [p] }, path)
  await h.page.getByTestId('pick-files').click()
  await enableSelectionStore(h)
  await h.page.getByTestId('book-card').click()
  await waitForLocationsReady(h)
  await h.page.getByRole('spinbutton', { name: 'PDF 跳转页码' }).fill('3')
  await h.page.getByRole('button', { name: '前往', exact: true }).click()
  await expect(h.page.getByTestId('pdf-scan-notice')).toBeVisible()
  return h.page.evaluate(async () => (await window.api.listBooks())[0].id)
}

/**
 * The fixture's scanned page is a coloured raster, not actual text. Stub only the
 * expensive recognizer, persist its deterministic output through the real schema,
 * and exercise capture, renderer integration, CFI anchors and restart normally.
 * Real model loading/recognition is checked separately by backend tests/smoke.
 */
async function mockRecognizer(h: Harness, hold = false, outcome: 'ok' | 'empty' | 'fail' = 'ok'): Promise<void> {
  await h.app.evaluate(({ ipcMain }, config) => {
    ipcMain.removeHandler('pdf:ocr')
    ipcMain.removeHandler('pdf:cancelOcr')
    const state = { input: null as any, calls: 0, cancelled: [] as string[], release: null as (() => void) | null,
      outcome: config.outcome, words: null as null | { text: string; x: number; y: number; width: number; height: number }[] }
    ;(globalThis as any).__ocrTest = state
    ipcMain.handle('pdf:cancelOcr', (_event, id: string) => { state.cancelled.push(id) })
    ipcMain.handle('pdf:ocr', async (event, input) => {
      state.input = { ...input, image: null, bytes: input.image.byteLength }
      state.calls++
      event.sender.send('pdf:ocrProgress', { requestId: input.requestId, status: '正在识别测试页面', progress: .5 })
      if (config.hold) await new Promise<void>(resolve => { state.release = resolve })
      if (state.outcome === 'fail') throw new Error('测试识别暂时失败')
      const result = {
        id: input.requestId, bookId: input.bookId, page: input.page, language: input.language,
        region: input.region, text: input.region ? 'Region reading text' : 'Scan reading text',
        words: state.words ?? [{ text: input.region ? 'Region' : 'Scan', x: .2, y: .2, width: .1, height: .03 },
          { text: 'reading', x: .31, y: .2, width: .12, height: .03 },
          { text: 'text', x: .44, y: .2, width: .08, height: .03 }],
        createdAt: Date.now()
      }
      // A late reply after cancellation must not create an OCR layer or revive UI.
      if (state.outcome === 'empty') { result.text = ''; result.words = [] }
      if (!state.cancelled.includes(input.requestId) && result.words.length) {
        const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')
        const db = new DatabaseSync(config.database)
        try {
          db.prepare(`INSERT INTO pdf_ocr (id, book_id, page, cache_key, language, region, text, words, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(result.id, result.bookId, result.page, result.id,
              result.language, result.region ? JSON.stringify(result.region) : null,
              result.text, JSON.stringify(result.words), result.createdAt)
        } finally { db.close() }
      }
      return result
    })
  }, { hold, outcome, database: join(h.userData, 'reader.db') })
}

async function pageBounds(h: Harness, index = 0) {
  return h.page.evaluate(index => {
    const frame = Array.from(document.querySelectorAll<HTMLIFrameElement>('.pdf-reader__frame'))
      .filter(item => item.style.visibility !== 'hidden')[index]
    const host = frame.getBoundingClientRect(), rect = frame.contentDocument!.querySelector('.page')!.getBoundingClientRect()
    return { x: host.x + rect.x, y: host.y + rect.y, width: rect.width, height: rect.height }
  }, index)
}

async function hoverPage(h: Harness, index = 0) {
  const bounds = await pageBounds(h, index)
  const input = await h.page.context().newCDPSession(h.page)
  await input.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: bounds.x + bounds.width * .3,
    y: bounds.y + bounds.height * .21 })
  await input.detach()
}

async function dragPage(h: Harness, options: { index?: number; horizontal?: boolean; escape?: boolean } = {}) {
  const bounds = await pageBounds(h, options.index)
  const input = await h.page.context().newCDPSession(h.page)
  const x = bounds.x + bounds.width * .15, y = bounds.y + bounds.height * (options.horizontal ? .215 : .15)
  const end = { x: x + bounds.width * .5, y: y + (options.horizontal ? 0 : bounds.height * .2) }
  await input.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await input.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await input.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...end, button: 'left', buttons: 1 })
  if (options.escape) {
    await input.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await input.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  }
  await input.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...end, button: 'left', buttons: 0, clickCount: 1 })
  // Leaving the page ensures a cancelled or failed request cannot immediately
  // restart because the synthetic pointer remains over the scanned image.
  await input.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 })
  await input.detach()
}

async function releaseRecognition(h: Harness, late = false) {
  await h.app.evaluate(({ BrowserWindow }, late) => {
    const state = (globalThis as any).__ocrTest
    if (late) BrowserWindow.getAllWindows()[0].webContents.send('pdf:ocrProgress', {
      requestId: state.input.requestId, status: 'late progress must be ignored', progress: 1
    })
    state.release()
  }, late)
}

async function geometry(h: Harness): Promise<{ x: number; y: number; width: number; scrollY: number }> {
  return h.page.evaluate(() => {
    const frame = Array.from(document.querySelectorAll<HTMLIFrameElement>('.pdf-reader__frame'))
      .find(item => item.style.visibility !== 'hidden')!
    const win = frame.contentWindow!, rect = frame.contentDocument!.querySelector('.page')!.getBoundingClientRect()
    return { x: (win.innerWidth / 2 - rect.left) / rect.width,
      y: (win.innerHeight / 2 - rect.top) / rect.height, width: rect.width, scrollY: win.scrollY }
  })
}

/** Capture displayed colours after Chromium compositing, not unfiltered source pixels. */
async function paperAndInk(h: Harness): Promise<{ paper: number[]; ink: number[] }> {
  const points = await h.page.evaluate(() => {
    const frame = Array.from(document.querySelectorAll<HTMLIFrameElement>('.pdf-reader__frame'))
      .find(item => item.style.visibility !== 'hidden')!
    const host = frame.getBoundingClientRect(), rect = frame.contentDocument!.querySelector('.page')!.getBoundingClientRect()
    return [.25, .75].map(x => ({ x: Math.floor(host.x + rect.x + rect.width * x),
      y: Math.floor(host.y + rect.y + rect.height * .5) }))
  })
  const png = (await h.page.screenshot({ scale: 'css', animations: 'disabled' })).toString('base64')
  return h.page.evaluate(async ({ png, points }) => {
    const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode()
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0)
    const [paper, ink] = points.map(point => Array.from(context.getImageData(point.x, point.y, 1, 1).data).slice(0, 3))
    return { paper, ink }
  }, { png, points })
}

test('PDF contrast does not replace a frame; cursor zoom and restart preserve the viewed area', async () => {
  let h = await launch()
  const bookId = await openScan(h)
  await h.page.getByTestId('pdf-scale').selectOption('2')
  await expect.poll(async () => (await geometry(h)).width).toBeCloseTo(1200, 0)
  await h.page.evaluate(() => document.querySelector<HTMLIFrameElement>('.pdf-reader__frame')!.contentWindow!.scrollTo(280, 400))
  const frame = await h.page.locator('.pdf-reader__frame:visible').elementHandle()
  await h.page.getByTestId('pdf-contrast').selectOption('1.5')
  await expect.poll(() => frame!.evaluate(item => (item as HTMLIFrameElement).contentDocument!
    .querySelector<HTMLImageElement>('.pdf-page-image')!.style.filter)).toContain('brightness(0.75) contrast(2)')
  expect(await frame!.evaluate(item => item.isConnected)).toBe(true)
  await frame!.dispose()
  const anchor = await h.page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('.pdf-reader__frame')!
    const win = frame.contentWindow!, host = frame.getBoundingClientRect()
    const rect = frame.contentDocument!.querySelector('.page')!.getBoundingClientRect()
    const screenX = win.innerWidth * .4, screenY = win.innerHeight * .5
    return { x: host.x + screenX, y: host.y + screenY, screenX, screenY,
      pageX: (screenX - rect.left) / rect.width, pageY: (screenY - rect.top) / rect.height }
  })
  const input = await h.page.context().newCDPSession(h.page)
  await input.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: anchor.x, y: anchor.y,
    deltaX: 0, deltaY: -100, modifiers: 2 })
  await input.detach()
  await expect.poll(async () => (await geometry(h)).width).toBeGreaterThan(1400)
  const afterAnchor = await h.page.evaluate(point => {
    const rect = document.querySelector<HTMLIFrameElement>('.pdf-reader__frame')!.contentDocument!
      .querySelector('.page')!.getBoundingClientRect()
    return { x: (point.screenX - rect.left) / rect.width, y: (point.screenY - rect.top) / rect.height }
  }, anchor)
  expect(afterAnchor.x).toBeCloseTo(anchor.pageX, 2)
  expect(afterAnchor.y).toBeCloseTo(anchor.pageY, 2)
  const before = await geometry(h)
  await expect.poll(() => h.page.evaluate(id => window.api.getPdfPosition(id), bookId)).toMatchObject({ page: 3 })
  await expect.poll(async () => (await h.page.evaluate(id => window.api.getPdfPosition(id), bookId))!.y).toBeCloseTo(before.y, 2)
  const profile = h.userData
  await h.app.close()
  h = await launch(profile)
  await mockRecognizer(h)
  await h.page.getByTestId('book-card').click()
  await expect(h.page.getByTestId('page-indicator')).toHaveText('第 3 / 3 页')
  await expect(h.page.getByTestId('pdf-contrast')).toHaveValue('1.5')
  await expect.poll(async () => (await geometry(h)).x).toBeCloseTo(before.x, 2)
  await expect.poll(async () => (await geometry(h)).y).toBeCloseTo(before.y, 2)
})

test('uneven Chinese OCR boxes select continuously, retain anchors after zoom/restart and erase in word gaps', async () => {
  let h = await launch()
  const bookId = await openScan(h)
  await h.app.evaluate(() => {
    (globalThis as any).__ocrTest.words = [
      { text: '他', x: .2, y: .2, width: .02, height: .02 },
      { text: '们', x: .225, y: .201, width: .018, height: .019 },
      { text: '，', x: .25, y: .213, width: .003, height: .006 },
      { text: '达', x: .27, y: .196, width: .025, height: .037 },
      { text: '国', x: .3, y: .201, width: .02, height: .019 },
      { text: '家', x: .325, y: .201, width: .02, height: .019 }
    ]
  })
  await hoverPage(h)
  const spans = () => h.page.frameLocator('.pdf-reader__frame').locator('.ocrLayer > div:first-child span')
  await expect(spans()).toHaveCount(6)
  const boxes = await spans().evaluateAll(items => items.map(item => {
    const r = item.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }
  }))
  expect(new Set(boxes.map(r => r.y)).size).toBe(1)
  expect(new Set(boxes.map(r => r.height)).size).toBe(1)
  for (let i = 0; i < 5; i++) expect(boxes[i].x + boxes[i].width).toBeCloseTo(boxes[i + 1].x, 1)
  const dragWords = async () => {
    const first = await spans().first().boundingBox(), last = await spans().last().boundingBox()
    if (!first || !last) throw new Error('OCR text is not visible')
    const input = await h.page.context().newCDPSession(h.page)
    const start = { x: first.x + .5, y: first.y + first.height / 2 }
    const end = { x: last.x + last.width - .5, y: last.y + last.height / 2 }
    await input.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...start })
    await input.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...start, button: 'left', buttons: 1, clickCount: 1 })
    await input.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...end, button: 'left', buttons: 1 })
    await input.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...end, button: 'left', buttons: 0, clickCount: 1 })
    await input.detach()
  }
  await dragWords()
  await expect(h.page.getByTestId('quote-chip')).toContainText('他 们 ， 达 国 家')
  await expect(h.page.getByTestId('pdf-highlight')).toHaveCount(1)
  await h.page.getByTestId('quote-chip').hover()
  await h.page.getByTestId('quote-annotate').click()
  await h.page.getByTestId('annotation-input').fill('字框修复后定位不变')
  await h.page.getByTestId('annotation-submit').click()
  const cfi = await h.page.evaluate(async id => (await window.api.listAnnotations(id))[0].cfiRange, bookId)
  await h.page.getByTestId('tool-highlight').click()
  await dragWords()
  await expect(h.page.getByTestId('pdf-highlight-persistent')).toHaveCount(1)
  await h.page.getByTestId('tool-erase').click()
  const gap = await spans().nth(2).boundingBox()
  const input = await h.page.context().newCDPSession(h.page)
  const point = { x: gap!.x + gap!.width * .9, y: gap!.y + gap!.height / 2 }
  await input.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 })
  await input.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 })
  await input.detach()
  await expect(h.page.getByTestId('pdf-highlight-persistent')).toHaveCount(0)
  await expect(h.page.getByTestId('annotation-marker')).toHaveCount(1)
  await h.page.getByTestId('pdf-scale').selectOption('2')
  await expect(h.page.getByTestId('annotation-marker')).toHaveCount(1)
  const profile = h.userData
  await h.app.close()
  h = await launch(profile)
  await mockRecognizer(h)
  await h.page.getByTestId('book-card').click()
  await expect(spans()).toHaveCount(6)
  await expect(h.page.getByTestId('annotation-marker')).toHaveCount(1)
  expect(await h.page.evaluate(async id => (await window.api.listAnnotations(id))[0].cfiRange, bookId)).toBe(cfi)
  await expect(h.page.getByTestId('page-indicator')).toHaveText('第 3 / 3 页')
})

test('hover recognizes a scan in place; selectable words and notes persist without OCR buttons or panels', async () => {
  let h = await launch()
  const bookId = await openScan(h)
  await enableSelectionStore(h)
  await mockRecognizer(h)
  await h.page.getByRole('combobox', { name: '文字识别语言' }).selectOption('eng')
  await expect(h.page.getByTestId('pdf-ocr-page')).toHaveCount(0)
  await expect(h.page.getByTestId('pdf-ocr-region')).toHaveCount(0)
  const frame = await h.page.locator('.pdf-reader__frame:visible').elementHandle()
  await hoverPage(h)
  await expect(h.page.frameLocator('.pdf-reader__frame').locator('.ocrLayer > div:first-child span')).toHaveCount(3)
  expect(await frame!.evaluate(item => item.isConnected)).toBe(true)
  await frame!.dispose()
  await expect(h.page.getByTestId('pdf-ocr-panel')).toHaveCount(0)
  await expect(h.page.getByTestId('pdf-scan-notice')).toHaveCount(0)
  await expect(h.page.getByTestId('tool-highlight')).toBeEnabled()
  await expect(h.page.getByTestId('read-aloud-toggle')).toBeEnabled()
  await expect(h.page.getByTestId('page-indicator')).toHaveText('第 3 / 3 页')
  const recognized = await h.app.evaluate(() => (globalThis as any).__ocrTest.input)
  expect(recognized).toMatchObject({ page: 3, language: 'eng', region: null })
  expect(recognized.bytes).toBeGreaterThan(100)
  await expect(h.page.frameLocator('.pdf-reader__frame').locator('.ocrLayer > div:first-child span')).toHaveCount(3)
  await h.page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('.pdf-reader__frame')!
    const doc = frame.contentDocument!, win = frame.contentWindow!
    const node = doc.querySelector('.ocrLayer > div:first-child span')!.firstChild!
    const range = doc.createRange(); range.setStart(node, 0); range.setEnd(node, 4)
    const selection = win.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    doc.dispatchEvent(new (win as any).MouseEvent('mouseup', { bubbles: true, button: 0 }))
    doc.dispatchEvent(new (win as any).MouseEvent('click', { bubbles: true, button: 0 }))
  })
  await expect(h.page.getByTestId('quote-chip')).toContainText('Scan')
  await h.page.getByTestId('quote-chip').hover()
  await h.page.getByTestId('quote-annotate').click()
  await h.page.getByTestId('annotation-input').fill('识别文字的稳定注释')
  await h.page.getByTestId('annotation-submit').click()
  await expect(h.page.getByTestId('annotation-marker')).toHaveCount(1)
  const cfi = await h.page.evaluate(async id => (await window.api.listAnnotations(id))[0].cfiRange, bookId)
  const profile = h.userData
  await h.app.close()
  h = await launch(profile)
  await mockRecognizer(h)
  await h.page.getByTestId('book-card').click()
  await expect(h.page.getByTestId('page-indicator')).toHaveText('第 3 / 3 页')
  await expect(h.page.frameLocator('.pdf-reader__frame').locator('.ocrLayer > div:first-child span')).toHaveCount(3)
  await expect(h.page.getByTestId('annotation-marker')).toHaveCount(1)
  expect(await h.page.evaluate(async id => (await window.api.listAnnotations(id))[0].cfiRange, bookId)).toBe(cfi)
  await hoverPage(h)
  await h.page.waitForTimeout(600)
  expect(await h.app.evaluate(() => (globalThis as any).__ocrTest.calls)).toBe(0)
  await h.page.getByTestId('pdf-scale').selectOption('2')
  await expect(h.page.getByTestId('annotation-marker')).toHaveCount(1)
  await expect(h.page.frameLocator('.pdf-reader__frame').locator('.ocrLayer > div:first-child span')).toHaveCount(3)
  await h.page.screenshot({ path: test.info().outputPath('pdf-ocr-result.png'), animations: 'disabled' })
})

test('dragging an unprepared scan directly recognizes and quotes the region without a misleading whole-page layer', async () => {
  const h = await launch()
  const bookId = await openScan(h)
  await enableSelectionStore(h)
  await mockRecognizer(h)
  await dragPage(h)
  await expect(h.page.getByTestId('quote-chip')).toContainText('Region reading text')
  const recognized = await h.app.evaluate(() => (globalThis as any).__ocrTest.input)
  expect(recognized.page).toBe(3)
  expect(recognized.region.x).toBeCloseTo(.15, 2)
  expect(recognized.region.y).toBeCloseTo(.15, 2)
  expect(recognized.region.width).toBeCloseTo(.5, 2)
  expect(recognized.region.height).toBeCloseTo(.2, 2)
  await expect(h.page.getByTestId('pdf-scan-notice')).toBeVisible()
  await expect(h.page.frameLocator('.pdf-reader__frame').locator('.ocrLayer > div:first-child span')).toHaveCount(0)
  await expect(h.page.getByTestId('pdf-ocr-panel')).toHaveCount(0)
  await expect(h.page.getByTestId('quote-chip')).toContainText('Region reading text')
  expect((await h.page.evaluate(id => window.api.getPdfOcr(id, 3), bookId))[0].region).not.toBeNull()
  await expect(h.page.getByTestId('page-indicator')).toHaveText('第 3 / 3 页')
})

test('recognizing a crop does not prevent later whole-page hover recognition or disturb its saved note anchor', async () => {
  const h = await launch()
  const bookId = await openScan(h)
  await mockRecognizer(h)
  await dragPage(h)
  await expect(h.page.getByTestId('quote-chip')).toContainText('Region reading text')
  await h.page.getByTestId('quote-chip').hover()
  await h.page.getByTestId('quote-annotate').click()
  await h.page.getByTestId('annotation-input').fill('先识别选区的稳定注释')
  await h.page.getByTestId('annotation-submit').click()
  await expect(h.page.getByTestId('annotation-marker')).toHaveCount(1)
  const cfi = await h.page.evaluate(async id => (await window.api.listAnnotations(id))[0].cfiRange, bookId)
  const frame = await h.page.locator('.pdf-reader__frame:visible').elementHandle()
  await hoverPage(h)
  await expect.poll(() => h.app.evaluate(() => (globalThis as any).__ocrTest.calls)).toBe(2)
  await expect(h.page.frameLocator('.pdf-reader__frame').locator('.ocrLayer > div:first-child span')).toHaveCount(3)
  expect(await h.app.evaluate(() => (globalThis as any).__ocrTest.input.region)).toBeNull()
  expect(await frame!.evaluate(item => item.isConnected)).toBe(true)
  await frame!.dispose()
  await expect(h.page.getByTestId('annotation-marker')).toHaveCount(1)
  expect(await h.page.evaluate(async id => (await window.api.listAnnotations(id))[0].cfiRange, bookId)).toBe(cfi)
  await expect(h.page.getByTestId('page-indicator')).toHaveText('第 3 / 3 页')
})

test('hover ignored while a region owns the worker is retried after completion without moving the pointer', async () => {
  const h = await launch()
  await openScan(h)
  await mockRecognizer(h, true)
  await dragPage(h)
  await expect(h.page.getByTestId('pdf-ocr-status')).toContainText('正在识别测试页面')
  await hoverPage(h)
  await h.page.waitForTimeout(600)
  expect(await h.app.evaluate(() => (globalThis as any).__ocrTest.calls)).toBe(1)
  await releaseRecognition(h)
  await expect(h.page.getByTestId('quote-chip')).toContainText('Region reading text')
  await expect.poll(() => h.app.evaluate(() => (globalThis as any).__ocrTest.calls)).toBe(2)
  expect(await h.app.evaluate(() => (globalThis as any).__ocrTest.input.region)).toBeNull()
  await releaseRecognition(h)
  await expect(h.page.frameLocator('.pdf-reader__frame').locator('.ocrLayer > div:first-child span')).toHaveCount(3)
  await expect(h.page.getByTestId('quote-chip')).toContainText('Region reading text')
  await expect(h.page.getByTestId('page-indicator')).toHaveText('第 3 / 3 页')
})

test('changing pages cancels background OCR and ignores late progress/results without relocating the reader', async () => {
  const h = await launch()
  await openScan(h)
  await mockRecognizer(h, true)
  await hoverPage(h)
  await expect(h.page.getByTestId('pdf-ocr-status')).toContainText('正在识别测试页面')
  await expect(h.page.getByRole('progressbar', { name: '文字识别进度' })).toHaveAttribute('value', '0.5')
  await h.page.getByRole('button', { name: '上一页', exact: true }).click()
  await expect(h.page.getByTestId('page-indicator')).toHaveText('第 2 / 3 页')
  await expect.poll(() => h.app.evaluate(() => (globalThis as any).__ocrTest.cancelled.length)).toBe(1)
  await releaseRecognition(h, true)
  await expect(h.page.getByTestId('pdf-ocr-status')).toHaveCount(0)
  await expect(h.page.getByTestId('pdf-ocr-panel')).toHaveCount(0)
  await expect(h.page.getByTestId('page-indicator')).toHaveText('第 2 / 3 页')
  await h.page.getByRole('button', { name: '下一页', exact: true }).click()
  await expect(h.page.getByTestId('pdf-scan-notice')).toBeVisible()
  await expect(h.page.frameLocator('.pdf-reader__frame').locator('.ocrLayer > div:first-child span')).toHaveCount(0)
  await hoverPage(h)
  await expect.poll(() => h.app.evaluate(() => (globalThis as any).__ocrTest.calls)).toBe(2)
  await releaseRecognition(h)
  await expect(h.page.frameLocator('.pdf-reader__frame').locator('.ocrLayer > div:first-child span')).toHaveCount(3)
})

test('mixed PDF spread allows direct selection of its scanned right page without moving the primary page', async () => {
  const h = await launch()
  const bookId = await openScan(h)
  await mockRecognizer(h)
  await h.page.getByRole('button', { name: '上一页', exact: true }).click()
  await expect(h.page.getByTestId('page-indicator')).toHaveText('第 2 / 3 页')
  await h.page.getByTestId('merge-next-page').click()
  await expect(h.page.locator('.pdf-reader__frame:visible')).toHaveCount(2)
  await expect(h.page.getByTestId('pdf-scan-notice')).toContainText('第 3 页没有文字层')
  await dragPage(h, { index: 1 })
  await expect(h.page.getByTestId('quote-chip')).toContainText('Region reading text')
  const recognized = await h.app.evaluate(() => (globalThis as any).__ocrTest.input)
  expect(recognized.page).toBe(3)
  expect(recognized.region.x).toBeCloseTo(.15, 2)
  expect(recognized.region.width).toBeCloseTo(.5, 2)
  await expect(h.page.getByTestId('pdf-ocr-panel')).toHaveCount(0)
  await expect(h.page.getByTestId('page-indicator')).toHaveText('第 2 / 3 页')
  await expect(h.page.locator('.pdf-reader__frame:visible')).toHaveCount(2)
  expect((await h.page.evaluate(id => window.api.getPdfOcr(id, 3), bookId))[0].page).toBe(3)
})

test('horizontal drag recognizes a line and Escape abandons an unfinished selection', async () => {
  const h = await launch()
  await openScan(h)
  await mockRecognizer(h)
  await dragPage(h, { horizontal: true, escape: true })
  await h.page.waitForTimeout(500)
  expect(await h.app.evaluate(() => (globalThis as any).__ocrTest.calls)).toBe(0)
  await expect(h.page.getByTestId('quote-chip')).toHaveCount(0)
  await dragPage(h, { horizontal: true })
  await expect(h.page.getByTestId('quote-chip')).toContainText('Region reading text')
  const recognized = await h.app.evaluate(() => (globalThis as any).__ocrTest.input)
  expect(recognized.region.width).toBeCloseTo(.5, 2)
  expect(recognized.region.height).toBeGreaterThan(0)
  expect(recognized.region.height).toBeLessThan(.1)
  await expect(h.page.getByTestId('pdf-ocr-panel')).toHaveCount(0)
})

test('selection made during background recognition survives zoom and quotes intersecting words without a second request', async () => {
  const h = await launch()
  await openScan(h)
  await mockRecognizer(h, true)
  await hoverPage(h)
  await expect(h.page.getByTestId('pdf-ocr-status')).toContainText('正在识别测试页面')
  await dragPage(h)
  expect(await h.app.evaluate(() => (globalThis as any).__ocrTest.calls)).toBe(1)
  await h.page.getByTestId('pdf-scale').selectOption('2')
  await expect.poll(async () => (await geometry(h)).width).toBeCloseTo(1200, 0)
  const frame = await h.page.locator('.pdf-reader__frame:visible').elementHandle()
  await releaseRecognition(h)
  await expect(h.page.getByTestId('quote-chip')).toContainText('Scan reading text')
  await expect(h.page.getByTestId('pdf-ocr-status')).toHaveCount(0)
  expect(await frame!.evaluate(item => item.isConnected)).toBe(true)
  await frame!.dispose()
  expect(await h.app.evaluate(() => (globalThis as any).__ocrTest.calls)).toBe(1)
  await expect(h.page.getByTestId('page-indicator')).toHaveText('第 3 / 3 页')
})

for (const outcome of ['empty', 'fail'] as const) {
  test(`automatic OCR ${outcome} offers an explicit retry without looping`, async () => {
    const h = await launch()
    await openScan(h)
    await mockRecognizer(h, false, outcome)
    await dragPage(h)
    await expect(h.page.getByRole('button', { name: '重试识别', exact: true })).toBeVisible()
    await expect(h.page.getByTestId('quote-chip')).toHaveCount(0)
    await hoverPage(h)
    await h.page.waitForTimeout(600)
    expect(await h.app.evaluate(() => (globalThis as any).__ocrTest.calls)).toBe(1)
    await h.app.evaluate(() => { (globalThis as any).__ocrTest.outcome = 'ok' })
    await h.page.getByRole('button', { name: '重试识别', exact: true }).click()
    await expect(h.page.getByTestId('quote-chip')).toContainText('Region reading text')
    await expect(h.page.getByRole('button', { name: '重试识别', exact: true })).toHaveCount(0)
    await expect(h.page.getByRole('progressbar', { name: '文字识别进度' })).toHaveCount(0)
    expect(await h.app.evaluate(() => (globalThis as any).__ocrTest.calls)).toBe(2)
  })

  test(`hovered whole-page OCR ${outcome} can be retried explicitly despite its existing error`, async () => {
    const h = await launch()
    await openScan(h)
    await mockRecognizer(h, false, outcome)
    await hoverPage(h)
    await expect(h.page.getByRole('button', { name: '重试识别', exact: true })).toBeVisible()
    expect(await h.app.evaluate(() => (globalThis as any).__ocrTest.input.region)).toBeNull()
    await h.page.waitForTimeout(600)
    expect(await h.app.evaluate(() => (globalThis as any).__ocrTest.calls)).toBe(1)
    await expect(h.page.frameLocator('.pdf-reader__frame').locator('.ocrLayer > div:first-child span')).toHaveCount(0)
    await h.app.evaluate(() => { (globalThis as any).__ocrTest.outcome = 'ok' })
    await h.page.getByRole('button', { name: '重试识别', exact: true }).click()
    await expect(h.page.frameLocator('.pdf-reader__frame').locator('.ocrLayer > div:first-child span')).toHaveCount(3)
    await expect(h.page.getByTestId('pdf-ocr-status')).toHaveCount(0)
    await expect(h.page.getByTestId('quote-chip')).toHaveCount(0)
    expect(await h.app.evaluate(() => (globalThis as any).__ocrTest.calls)).toBe(2)
    expect(await h.app.evaluate(() => (globalThis as any).__ocrTest.input.region)).toBeNull()
  })
}

test('native PDF text never triggers OCR, and a background request can be cancelled without a panel', async () => {
  const h = await launch()
  await openScan(h)
  await mockRecognizer(h, true)
  await h.page.getByRole('button', { name: '上一页', exact: true }).click()
  await expect(h.page.getByTestId('page-indicator')).toHaveText('第 2 / 3 页')
  await hoverPage(h)
  await h.page.waitForTimeout(600)
  expect(await h.app.evaluate(() => (globalThis as any).__ocrTest.calls)).toBe(0)
  await h.page.getByRole('button', { name: '下一页', exact: true }).click()
  await expect(h.page.getByTestId('pdf-scan-notice')).toBeVisible()
  await hoverPage(h)
  await expect(h.page.getByTestId('pdf-ocr-status')).toContainText('正在识别测试页面')
  await h.page.getByRole('button', { name: '取消识别', exact: true }).click()
  await expect.poll(() => h.app.evaluate(() => (globalThis as any).__ocrTest.cancelled.length)).toBe(1)
  await releaseRecognition(h, true)
  await expect(h.page.getByRole('button', { name: '取消识别', exact: true })).toHaveCount(0)
  await expect(h.page.getByTestId('pdf-ocr-status')).not.toContainText('late progress')
  await expect(h.page.frameLocator('.pdf-reader__frame').locator('.ocrLayer > div:first-child span')).toHaveCount(0)
  await expect(h.page.getByTestId('quote-chip')).toHaveCount(0)
})

test('cancelling a held region prevents hovering from silently starting whole-page OCR or accepting its late result', async () => {
  const h = await launch()
  const bookId = await openScan(h)
  await mockRecognizer(h, true)
  await dragPage(h)
  await expect(h.page.getByTestId('pdf-ocr-status')).toContainText('正在识别测试页面')
  expect(await h.app.evaluate(() => (globalThis as any).__ocrTest.input.region)).not.toBeNull()
  await h.page.getByRole('button', { name: '取消识别', exact: true }).click()
  await expect.poll(() => h.app.evaluate(() => (globalThis as any).__ocrTest.cancelled.length)).toBe(1)
  await hoverPage(h)
  await releaseRecognition(h, true)
  await h.page.waitForTimeout(600)
  expect(await h.app.evaluate(() => (globalThis as any).__ocrTest.calls)).toBe(1)
  await expect(h.page.getByRole('button', { name: '取消识别', exact: true })).toHaveCount(0)
  await expect(h.page.getByTestId('pdf-ocr-status')).not.toContainText('late progress')
  await expect(h.page.getByTestId('quote-chip')).toHaveCount(0)
  await expect(h.page.frameLocator('.pdf-reader__frame').locator('.ocrLayer > div:first-child span')).toHaveCount(0)
  expect(await h.page.evaluate(id => window.api.getPdfOcr(id, 3), bookId)).toHaveLength(0)
})

test('rapid contrast/scale edits merge pending settings and preserve a pending cursor zoom', async () => {
  const h = await launch()
  await openScan(h)
  await h.page.getByTestId('pdf-scale').selectOption('2')
  await expect.poll(async () => (await geometry(h)).width).toBeCloseTo(1200, 0)
  await h.page.evaluate(() => {
    const contrast = document.querySelector<HTMLSelectElement>('[data-testid="pdf-contrast"]')!
    const scale = document.querySelector<HTMLSelectElement>('[data-testid="pdf-scale"]')!
    contrast.value = '1.5'; contrast.dispatchEvent(new Event('change', { bubbles: true }))
    scale.value = '3'; scale.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await expect(h.page.getByTestId('pdf-scale')).toHaveValue('3')
  await expect(h.page.getByTestId('pdf-contrast')).toHaveValue('1.5')
  await expect.poll(() => h.page.evaluate(async () => JSON.parse((await window.api.getSetting('pdfView'))!)))
    .toMatchObject({ mode: 'custom', scale: 3, contrast: 1.5 })
  await expect.poll(async () => (await geometry(h)).width).toBeCloseTo(1800, 0)
  await h.page.evaluate(() => document.querySelector<HTMLIFrameElement>('.pdf-reader__frame')!.contentWindow!.scrollTo(400, 650))
  const anchor = await h.page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('.pdf-reader__frame')!
    const doc = frame.contentDocument!, win = frame.contentWindow!
    const rect = doc.querySelector('.page')!.getBoundingClientRect()
    const screenX = win.innerWidth * .4, screenY = win.innerHeight * .5
    const anchor = { screenX, screenY, x: (screenX - rect.left) / rect.width, y: (screenY - rect.top) / rect.height }
    // One browser turn deliberately targets the wheel debounce race. Trusted CDP
    // input is covered above; here contrast must merge the engine's pending zoom.
    doc.dispatchEvent(new (win as any).WheelEvent('wheel', {
      ctrlKey: true, deltaY: 100, clientX: screenX, clientY: screenY, bubbles: true, cancelable: true
    }))
    const contrast = document.querySelector<HTMLSelectElement>('[data-testid="pdf-contrast"]')!
    contrast.value = '2'; contrast.dispatchEvent(new Event('change', { bubbles: true }))
    return anchor
  })
  await expect.poll(async () => (await geometry(h)).width).toBeCloseTo(600 * 3 * Math.exp(-.2), 0)
  await expect(h.page.getByTestId('pdf-contrast')).toHaveValue('2')
  await expect.poll(() => h.page.evaluate(async () => JSON.parse((await window.api.getSetting('pdfView'))!)))
    .toMatchObject({ mode: 'custom', contrast: 2 })
  expect(await h.page.evaluate(async () => JSON.parse((await window.api.getSetting('pdfView'))!).scale))
    .toBeCloseTo(3 * Math.exp(-.2), 3)
  const after = await h.page.evaluate(point => {
    const rect = document.querySelector<HTMLIFrameElement>('.pdf-reader__frame')!.contentDocument!
      .querySelector('.page')!.getBoundingClientRect()
    return { x: (point.screenX - rect.left) / rect.width, y: (point.screenY - rect.top) / rect.height }
  }, anchor)
  expect(after.x).toBeCloseTo(anchor.x, 2)
  expect(after.y).toBeCloseTo(anchor.y, 2)
  await expect(h.page.getByTestId('page-indicator')).toHaveText('第 3 / 3 页')
})

test('contrast enhances faint scan ink in both themes without changing paper or clipping night text', async () => {
  const h = await launch()
  await openScan(h)
  await h.page.getByRole('button', { name: '适合整页', exact: true }).click()
  const frame = await h.page.locator('.pdf-reader__frame:visible').elementHandle()
  await frame!.evaluate(async item => {
    const image = (item as HTMLIFrameElement).contentDocument!.querySelector<HTMLImageElement>('.pdf-page-image')!
    const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 128
    const context = canvas.getContext('2d')!
    context.fillStyle = '#fff'; context.fillRect(0, 0, 64, 128)
    context.fillStyle = '#ccc'; context.fillRect(64, 0, 64, 128)
    // Only replace the isolated fixture image. Retain display dimensions and text
    // DOM/CFI paths; the compositor then sees known faint ink and white paper.
    image.src = canvas.toDataURL('image/png'); await image.decode()
  })
  const lightRaw = await paperAndInk(h)
  expect(lightRaw.paper.every(channel => channel > 245)).toBe(true)
  expect(lightRaw.ink.every(channel => Math.abs(channel - 204) < 15)).toBe(true)
  await h.page.getByTestId('pdf-contrast').selectOption('2')
  await expect.poll(async () => {
    const current = await paperAndInk(h)
    return current.paper.every((channel, i) => Math.abs(channel - lightRaw.paper[i]) < 6)
      && current.ink.every((channel, i) => channel < lightRaw.ink[i] - 25)
  }).toBe(true)
  expect(await frame!.evaluate(item => item.isConnected)).toBe(true)
  await h.page.getByTestId('pdf-contrast').selectOption('1')
  await h.page.getByTestId('toggle-theme').click()
  await expect.poll(() => frame!.evaluate(item => (item as HTMLIFrameElement).contentDocument!
    .documentElement.classList.contains('dark'))).toBe(true)
  const darkRaw = await paperAndInk(h)
  expect(darkRaw.paper.every(channel => channel < 40)).toBe(true)
  expect(darkRaw.ink.every((channel, i) => channel > darkRaw.paper[i] + 25)).toBe(true)
  await h.page.getByTestId('pdf-contrast').selectOption('2')
  await expect.poll(async () => {
    const current = await paperAndInk(h)
    return current.paper.every((channel, i) => Math.abs(channel - darkRaw.paper[i]) < 6)
      && current.ink.every((channel, i) => channel > darkRaw.ink[i] + 25)
  }).toBe(true)
  expect(await frame!.evaluate(item => item.isConnected)).toBe(true)
  await frame!.dispose()
  await expect(h.page.getByTestId('page-indicator')).toHaveText('第 3 / 3 页')
})
