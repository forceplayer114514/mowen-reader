import { EpubCFI } from 'epubjs'
import { TextLayer, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist'
import pdfStyles from 'pdfjs-dist/web/pdf_viewer.css?inline'
import { loadPdf, pdfError } from './pdf'
import { makeRangeCfi } from './cfi'
import { layoutPdfOcrWords, mergePdfTextRects } from './pdf-selection'
import type { PdfOcrRegion, PdfOcrResult } from '../../shared/pdf-ocr-types'
import { splitPdfParagraphs } from '../../shared/book-translation'
import type { AnnotationMarker, BookSearchResult, PersistentHighlightItem, ReaderEngine, ReadingTool, SelectionPoint, ThemeName, TocItem, VisibleRange, PdfViewSettings, OpenOptions } from './types'
import { MAX_SEARCH_RESULTS, normalizePdfView, normalizeSearchQuery, pdfImageFilter, searchPdfPages } from './types'

export { searchPdfPages, pdfExcerptForMatch } from './types'

interface PageView {
  number: number
  frame: HTMLIFrameElement
  doc: Document
  text: string
  start: string
  end: string
  scale: number
  imageUrl?: string
  viewport?: { width: number; height: number; x: number; y: number }
  cancelDrag?: () => void
  ocrQuotes?: Map<string, { cfiRange: string; startCfi: string }>
  usesOcr?: boolean
  isScan?: boolean
  selectableLayer?: HTMLElement
  cancelHover?: () => void
}

/** One stable CFI base per physical PDF page; text-layer DOM never includes our marks. */
function base(page: number): string { return `/6/${page * 2}[pdf-page-${page}]` }

export function pdfPageFromTarget(target: string, total: number): number {
  const page = target.startsWith('epubcfi(') ? new EpubCFI(target).spinePos + 1
    : Number(/^pdf-page-(\d+)$/.exec(target)?.[1])
  if (!Number.isSafeInteger(page) || page < 1 || page > total) throw new Error('PDF 页码无效')
  return page
}

export function createPdfEngine(container: HTMLElement): ReaderEngine {
  let pdf: PDFDocumentProxy | null = null
  let loading: ReturnType<typeof loadPdf> | null = null
  let currentPage = 1
  let targetCfi: string | null = null
  let spread = false
  let viewSettings = normalizePdfView(null)
  let renderedSettings = viewSettings
  let renderedSize = { width: 0, height: 0 }
  let theme: ThemeName = 'light'
  let outline: TocItem[] = []
  let views: PageView[] = []
  let generation = 0
  let destroyed = false
  let hasDisplayed = false
  let tasks: RenderTask[] = []
  const captureTasks = new Set<RenderTask>()
  let resizeFrame = 0
  let drawing: Promise<void> = Promise.resolve()
  let marks: HTMLElement[] = []
  let annotations: AnnotationMarker[] = []
  let onAnnotationClick: (id: string) => void = () => {}
  const highlights = new Map<string, () => void>()
  // 持久荧光笔:范围 -> id,和临时引用那份账分开记,画出来的层类名也不同。
  // PDF 这边两套本来就是各自独立的 span,不存在 epub 那边共用标注槽位的问题,
  // 互不覆盖;点击按坐标命中时持久层优先(见下面的 click 处理)。
  const persistent = new Map<string, string>()
  let persistentClick: (id: string) => void = () => {}
  // 橡皮模式下拖选不再当引用交出去,选区留给用户复制;其它行为不变。
  let readingTool: ReadingTool = 'select'
  const relocated = new Set<() => void>()
  const keys = new Set<(key: string) => void>()
  const selections = new Set<(range: string, text: string, point: SelectionPoint | null, start: string) => void>()
  let readPosition: ((text: string) => void) | null = null
  let cachedOcr: OpenOptions['getPdfOcr']
  let onViewChange: OpenOptions['onPdfViewChange']
  let onPositionChange: OpenOptions['onPdfPositionChange']
  let savedPosition: OpenOptions['pdfPosition']
  let positionTimer: ReturnType<typeof setTimeout> | undefined
  let zoomTimer: ReturnType<typeof setTimeout> | undefined
  let zoomAnchor: { page: number; x: number; y: number; screenX: number; screenY: number } | null = null
  const regionListeners = new Set<(page: number, region: PdfOcrRegion) => void>()
  const ocrNeeded = new Set<(page: number) => boolean>()
  container.classList.add('pdf-reader')

  function emit(): void { if (!destroyed) relocated.forEach((cb) => cb()) }
  function removePage(view: PageView): void {
    view.cancelDrag?.()
    view.cancelHover?.()
    view.frame.remove()
    if (view.imageUrl) URL.revokeObjectURL(view.imageUrl)
  }
  function rememberPosition(view: PageView, reset = false): void {
    const win = view.doc.defaultView
    if (!win || !view.frame.isConnected) return
    // ResizeObserver runs after the old iframe has resized. Keep its PRE-resize center,
    // including when Chromium clamps the old scroll offset to the new viewport size.
    if (!reset && view.viewport && (win.innerWidth !== view.viewport.width || win.innerHeight !== view.viewport.height)) return
    const rect = view.doc.querySelector('.page')!.getBoundingClientRect()
    view.viewport = { width: win.innerWidth, height: win.innerHeight,
      x: (win.innerWidth / 2 - rect.left) / rect.width, y: (win.innerHeight / 2 - rect.top) / rect.height }
    if (view.number === currentPage && views.includes(view)) {
      clearTimeout(positionTimer)
      positionTimer = setTimeout(() => { const position = getPosition(); if (position) onPositionChange?.(position) }, 150)
    }
  }
  function getPosition(): { page: number; x: number; y: number } | null {
    const view = views.find((v) => v.number === currentPage)
    if (!view?.viewport) return null
    return { page: currentPage, x: Math.max(0, Math.min(1, view.viewport.x)), y: Math.max(0, Math.min(1, view.viewport.y)) }
  }
  function applyImageStyle(view: PageView): void {
    const image = view.doc.querySelector<HTMLImageElement>('.pdf-page-image')
    if (image) image.style.filter = pdfImageFilter(theme, viewSettings.contrast)
  }
  function onKey(event: KeyboardEvent): void {
    const el = event.target as HTMLElement | null
    if (el?.closest('input, textarea, select, [contenteditable="true"]')) return
    if (event.key === 'Escape') views.forEach((v) => v.cancelDrag?.())
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      keys.forEach((cb) => cb('Find'))
      return
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return
    if (['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'].includes(event.key)) event.preventDefault()
    keys.forEach((cb) => cb(event.key))
  }
  window.addEventListener('keydown', onKey)

  function rangeFor(cfi: string): { view: PageView; range: Range } | null {
    try {
      const parsed = new EpubCFI(cfi)
      const view = views.find((v) => v.number === parsed.spinePos + 1)
      return view ? { view, range: parsed.toRange(view.doc) } : null
    } catch { return null }
  }

  function rangeRects(range: Range): DOMRect[] {
    return mergePdfTextRects(Array.from(range.getClientRects()).map(r => ({ x: r.x, y: r.y, width: r.width, height: r.height })))
      .map(r => new DOMRect(r.x, r.y, r.width, r.height))
  }

  function drawMarks(): void {
    marks.forEach((el) => el.remove())
    marks = []
    const host = container.getBoundingClientRect()
    function rectangles(cfi: string): DOMRect[] {
      const found = rangeFor(cfi)
      if (!found) return []
      const frame = found.view.frame.getBoundingClientRect()
      return rangeRects(found.range)
        .map((r) => new DOMRect(r.left + frame.left - host.left, r.top + frame.top - host.top, r.width, r.height))
        .filter((r) => r.bottom > 0 && r.top < host.height && r.right > 0 && r.left < host.width)
    }
    function add(el: HTMLElement, rect: DOMRect, top: number, height: number): void {
      Object.assign(el.style, { position: 'absolute', left: `${rect.left}px`, top: `${top}px`, width: `${rect.width}px`, height: `${height}px` })
      container.append(el)
      marks.push(el)
    }
    for (const cfi of highlights.keys()) {
      for (const rect of rectangles(cfi)) {
        const el = document.createElement('span')
        el.className = 'pdf-highlight'
        el.dataset.testid = 'pdf-highlight'
        add(el, rect, rect.top, rect.height)
      }
    }
    for (const [cfi, id] of persistent) {
      for (const rect of rectangles(cfi)) {
        const el = document.createElement('span')
        el.className = 'pdf-highlight-persistent'
        el.dataset.testid = 'pdf-highlight-persistent'
        el.dataset.highlightId = id
        add(el, rect, rect.top, rect.height)
      }
    }
    const occupied = new Map<string, number>()
    for (const note of annotations) {
      const rects = rectangles(note.cfiRange)
      for (const rect of rects) {
        const line = document.createElement('span')
        line.className = 'annotation-underline'
        line.dataset.testid = 'annotation-underline'
        line.setAttribute('aria-hidden', 'true')
        add(line, rect, rect.bottom - 1, 1)
      }
      const last = rects.at(-1)
      if (!last) continue
      const key = `${Math.round(last.right)}:${Math.round(last.top)}`
      const shift = occupied.get(key) ?? 0
      occupied.set(key, shift + 14)
      const marker = document.createElement('button')
      marker.type = 'button'
      marker.className = 'annotation-marker'
      marker.dataset.testid = 'annotation-marker'
      marker.dataset.annotationId = note.id
      marker.setAttribute('aria-label', `查看注释 ${note.number}`)
      const sup = document.createElement('sup')
      sup.textContent = String(note.number)
      marker.append(sup)
      marker.style.left = `${Math.min(host.width - 16, last.right + shift)}px`
      marker.style.top = `${Math.max(0, last.top - 6)}px`
      marker.onclick = () => onAnnotationClick(note.id)
      container.append(marker)
      marks.push(marker)
    }
  }

  function updateTextBounds(view: PageView): void {
    const nodes: Text[] = []
    const walker = view.doc.createTreeWalker(view.selectableLayer!, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) nodes.push(walker.currentNode as Text)
    if (nodes.length) {
      const range = view.doc.createRange()
      range.setStart(nodes[0], 0); range.setEnd(nodes.at(-1)!, nodes.at(-1)!.length)
      const start = new EpubCFI(range, base(view.number)), end = new EpubCFI(range, base(view.number))
      start.collapse(true); end.collapse(false)
      view.start = start.toString(); view.end = end.toString()
    } else {
      view.start = `epubcfi(${base(view.number)}!/4:0)`
      view.end = `epubcfi(${base(view.number)}!/4:1)`
    }
  }

  async function loadOcr(view: PageView): Promise<void> {
    if (!cachedOcr) return
    const results = await cachedOcr(view.number)
    if (destroyed || !view.frame.isConnected) return
    const wrapper = view.doc.querySelector<HTMLElement>('.page')!
    const whole = view.doc.querySelector<HTMLElement>('.ocrLayer > div:first-child')!
    const regions = view.doc.querySelector<HTMLElement>('.ocrLayer > div:nth-child(2)')!
    const width = parseFloat(wrapper.style.width), height = parseFloat(wrapper.style.height)
    const measure = document.createElement('canvas').getContext('2d')!
    const appendWords = (result: PdfOcrResult, host: HTMLElement): void => {
      for (const word of layoutPdfOcrWords(result.words, height / width)) {
        if (!word.text || ![word.x, word.y, word.width, word.height].every(Number.isFinite)
          || word.x < 0 || word.y < 0 || word.width <= 0 || word.height <= 0
          || word.x + word.width > 1.000001 || word.y + word.height > 1.000001) continue
        const span = view.doc.createElement('span')
        span.textContent = `${word.text} `
        const fontSize = Math.max(1, word.height * height * .9)
        measure.font = `${fontSize}px sans-serif`
        const textWidth = Math.max(1, measure.measureText(span.textContent).width)
        Object.assign(span.style, { left: `${word.x * width}px`, top: `${word.y * height}px`,
          fontSize: `${fontSize}px`, fontFamily: 'sans-serif',
          width: `${textWidth}px`, height: `${word.height * height}px`, lineHeight: `${word.height * height}px`,
          transform: `scaleX(${word.width * width / textWidth})` })
        host.append(span)
      }
    }
    const result = results.find(r => !r.region && r.words.length)
    // Never replace existing nodes: quotations and saved notes use their stable CFI paths.
    if (!view.text && result && !whole.childNodes.length) {
      whole.dataset.resultId = result.id
      appendWords(result, whole)
      if (whole.childNodes.length) {
        view.text = result.text; view.selectableLayer = whole; view.usesOcr = true
        wrapper.classList.remove('scan-pending')
      }
    }
    view.ocrQuotes ??= new Map()
    for (const result of results.filter(r => r.region)) {
      if (view.doc.getElementById(`ocr-${result.id}`)) continue
      const host = view.doc.createElement('div'); host.id = `ocr-${result.id}`
      Object.assign(host.style, { userSelect: 'none', pointerEvents: 'none' })
      regions.append(host); appendWords(result, host)
      const nodes: Text[] = []
      const iterator = view.doc.createTreeWalker(host, NodeFilter.SHOW_TEXT)
      while (iterator.nextNode()) nodes.push(iterator.currentNode as Text)
      if (nodes.length) {
        const range = view.doc.createRange()
        range.setStart(nodes[0], 0); range.setEnd(nodes.at(-1)!, nodes.at(-1)!.length)
        const start = new EpubCFI(range, base(view.number)); start.collapse(true)
        view.ocrQuotes.set(result.id, { cfiRange: new EpubCFI(range, base(view.number)).toString(), startCfi: start.toString() })
      }
    }
    updateTextBounds(view)
  }

  async function draw(preservePosition: boolean): Promise<void> {
    if (!pdf || destroyed || container.clientWidth < 1 || container.clientHeight < 1) return
    const source = pdf
    const gen = ++generation
    const settings = { ...viewSettings }
    const anchor = zoomAnchor
    const size = { width: container.clientWidth, height: container.clientHeight }
    tasks.forEach((task) => task.cancel())
    tasks = []
    const pages = spread && currentPage < source.numPages ? [currentPage, currentPage + 1] : [currentPage]
    const nextViews: PageView[] = []
    try {
      for (const number of pages) {
        const page = await source.getPage(number)
        if (gen !== generation || destroyed) return
        const natural = page.getViewport({ scale: 1 })
        const widthScale = (size.width / pages.length - 24) / natural.width
        const scale = settings.mode === 'custom' ? settings.scale : settings.mode === 'width' ? widthScale
          : Math.min(widthScale, (size.height - 24) / natural.height)
        const viewport = page.getViewport({ scale: Math.max(0.1, scale) })
        const frame = document.createElement('iframe')
        frame.title = `PDF 第 ${number} 页`
        frame.setAttribute('sandbox', 'allow-same-origin')
        frame.className = 'pdf-reader__frame'
        frame.style.width = `${100 / pages.length}%`
        // Keep old pages until rendering succeeds; pending frames are not visible or selectable.
        frame.style.visibility = 'hidden'
        frame.style.position = 'absolute'
        container.append(frame)
        const doc = frame.contentDocument!
        doc.open()
        doc.write(`<!doctype html><html><head><meta charset="UTF-8"><style>${pdfStyles}\nhtml,body{margin:0;min-height:100%;background:transparent}body{width:max-content;min-width:100%;padding:12px;box-sizing:border-box}.page{position:relative;margin:0 auto;--scale-round-x:1px;--scale-round-y:1px}canvas,.pdf-page-image{display:block}.pdf-page-image{pointer-events:none;user-select:none;-webkit-user-drag:none}.textLayer{z-index:1}.textLayer ::selection,.ocrLayer ::selection{background:rgba(226,118,76,.4)}.ocrLayer{position:absolute;inset:0;z-index:1;color:transparent;pointer-events:none}.ocrLayer span{position:absolute;white-space:pre;transform-origin:left top;line-height:1;cursor:text;pointer-events:auto}.ocrLayer>div:nth-child(2) span{pointer-events:none;user-select:none}.ocr-region{position:absolute;border:2px solid #e2764c;background:rgba(226,118,76,.16);pointer-events:none;box-sizing:border-box;z-index:2}html.pan{cursor:grab}html.pan .textLayer,html.pan .ocrLayer span,html.ocr .textLayer,html.ocr .ocrLayer span{pointer-events:none;user-select:none}html.ocr{cursor:crosshair}html.dragging{cursor:grabbing}</style></head><body><div class="page"><canvas></canvas><div class="textLayer"></div><div class="ocrLayer"></div></div></body></html>`)
        doc.close()
        nextViews.push({ number, frame, doc, text: '', start: '', end: '', scale: viewport.scale })
        const view = nextViews.at(-1)!
        doc.documentElement.classList.toggle('dark', theme === 'dark')
        doc.documentElement.classList.toggle('pan', readingTool === 'pan')
        const wrapper = doc.querySelector<HTMLElement>('.page')!
        wrapper.style.width = `${viewport.width}px`
        wrapper.style.height = `${viewport.height}px`
        wrapper.style.setProperty('--total-scale-factor', String(viewport.scale))
        const canvas = doc.querySelector('canvas')!
        // ponytail: bound canvas memory to 16M pixels; use tiled rendering if giant pages need sharper zoom.
        const ratio = Math.min(3, window.devicePixelRatio || 1, 16_384 / viewport.width, 16_384 / viewport.height,
          Math.sqrt(15_900_000 / (viewport.width * viewport.height)))
        canvas.width = Math.ceil(viewport.width * ratio)
        canvas.height = Math.ceil(viewport.height * ratio)
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`
        const task = page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport, transform: [ratio, 0, 0, ratio, 0, 0] })
        tasks.push(task)
        const content = await page.getTextContent()
        const layer = doc.querySelector<HTMLElement>('.textLayer')!
        await Promise.all([task.promise, new TextLayer({ textContentSource: content, container: layer, viewport }).render()])
        if (gen !== generation || destroyed) return
        // Electron can keep a sandboxed iframe canvas blank despite valid pixels.
        // Present a decoded image, replacing the canvas in place so existing CFIs stay stable.
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) =>
          value ? resolve(value) : reject(new Error('PDF 页面图像生成失败'))))
        if (gen !== generation || destroyed) return
        view.imageUrl = URL.createObjectURL(blob)
        const image = doc.createElement('img')
        image.className = 'pdf-page-image'
        image.alt = ''
        image.draggable = false
        image.style.width = canvas.style.width
        image.style.height = canvas.style.height
        image.src = view.imageUrl
        await image.decode()
        if (gen !== generation || destroyed) return
        canvas.replaceWith(image)
        applyImageStyle(view)
        view.text = content.items.map((item) => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '').join('').trim()
        view.isScan = !view.text
        view.selectableLayer = layer
        // Permanent slots preserve region CFIs when a whole-page layer arrives later.
        const whole = doc.createElement('div'), regions = doc.createElement('div')
        regions.setAttribute('aria-hidden', 'true')
        doc.querySelector('.ocrLayer')!.append(whole, regions)
        wrapper.classList.toggle('scan-pending', !view.text)
        await loadOcr(view)
        if (gen !== generation || destroyed) return
        updateTextBounds(view)
        let swallowClick = false
        let drag: { id: number; x: number; y: number; left: number; top: number } | null = null
        let regionDrag: { id: number; x: number; y: number; element: HTMLElement } | null = null
        let hoverTimer: ReturnType<typeof setTimeout> | undefined
        let hoverRequested = false
        view.cancelHover = () => { clearTimeout(hoverTimer); hoverTimer = undefined }
        wrapper.style.cursor = readingTool === 'pan' ? 'grab' : 'text'
        const scheduleHover = (): void => {
          if (view.text || readingTool !== 'select' || regionDrag || hoverRequested || hoverTimer) return
          hoverTimer = setTimeout(() => {
            hoverTimer = undefined
            if (destroyed || !views.includes(view) || view.text || readingTool !== 'select' || regionDrag) return
            hoverRequested = Array.from(ocrNeeded).some(cb => cb(number))
            // A region/other page may currently own the worker. An ignored hover
            // stays pending while the pointer is here, rather than becoming inert.
            if (!hoverRequested) scheduleHover()
          }, 350)
        }
        wrapper.addEventListener('pointermove', (event) => {
          if (!event.buttons) scheduleHover()
        })
        wrapper.addEventListener('pointerleave', () => { view.cancelHover?.(); hoverRequested = false })
        const pagePoint = (event: PointerEvent): { x: number; y: number } => {
          const rect = wrapper.getBoundingClientRect()
          return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
            y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) }
        }
        const updateRegion = (event: PointerEvent): PdfOcrRegion | null => {
          if (!regionDrag || regionDrag.id !== event.pointerId) return null
          const point = pagePoint(event)
          const region = { x: Math.min(point.x, regionDrag.x), y: Math.min(point.y, regionDrag.y),
            width: Math.abs(point.x - regionDrag.x), height: Math.abs(point.y - regionDrag.y) }
          Object.assign(regionDrag.element.style, { left: `${region.x * 100}%`, top: `${region.y * 100}%`,
            width: `${region.width * 100}%`, height: `${region.height * 100}%` })
          return region
        }
        const endDrag = (): void => {
          const id = drag?.id ?? regionDrag?.id
          if (id === undefined) return
          drag = null
          regionDrag?.element.remove(); regionDrag = null
          swallowClick = true
          doc.documentElement.classList.remove('dragging')
          if (doc.documentElement.hasPointerCapture(id)) doc.documentElement.releasePointerCapture(id)
        }
        view.cancelDrag = endDrag
        doc.addEventListener('pointerdown', (event) => {
          const scanSelection = readingTool === 'select' && !view.text
          if ((readingTool !== 'pan' && !scanSelection) || event.button !== 0) return
          event.preventDefault()
          view.cancelHover?.()
          endDrag()
          if (scanSelection) {
            const rect = wrapper.getBoundingClientRect()
            if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return
            const point = pagePoint(event)
            const element = doc.createElement('div'); element.className = 'ocr-region'; wrapper.append(element)
            regionDrag = { id: event.pointerId, ...point, element }
            updateRegion(event)
          } else {
            const win = doc.defaultView!
            drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: win.scrollX, top: win.scrollY }
            doc.documentElement.classList.add('dragging')
          }
          doc.documentElement.setPointerCapture(event.pointerId)
        })
        doc.addEventListener('pointermove', (event) => {
          if (regionDrag) { updateRegion(event); return }
          if (!drag || drag.id !== event.pointerId || readingTool !== 'pan') return
          doc.defaultView!.scrollTo(drag.left + drag.x - event.clientX, drag.top + drag.y - event.clientY)
        })
        doc.addEventListener('pointerup', (event) => {
          const region = regionDrag ? updateRegion(event) : null
          endDrag()
          if (region && region.width * viewport.width >= 8) {
            // Horizontal sentence drags still need a crop with a line's height.
            if (region.height * viewport.height < 8) {
              region.height = Math.min(1, 28 / viewport.height)
              region.y = Math.max(0, Math.min(1 - region.height, region.y - region.height / 2))
            }
            regionListeners.forEach((cb) => cb(number, region))
          }
        })
        doc.addEventListener('pointercancel', endDrag)
        doc.addEventListener('lostpointercapture', endDrag)
        doc.defaultView?.addEventListener('blur', endDrag)
        doc.addEventListener('wheel', (event) => {
          if (!(event.ctrlKey || event.metaKey) || destroyed) return
          event.preventDefault()
          endDrag()
          const rect = wrapper.getBoundingClientRect()
          const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? doc.defaultView!.innerHeight : 1
          const nextScale = Math.max(.25, Math.min(4, (viewSettings.mode === 'custom' ? viewSettings.scale : view.scale) * Math.exp(-event.deltaY * units * .002)))
          viewSettings = normalizePdfView({ ...viewSettings, mode: 'custom', scale: nextScale })
          zoomAnchor = { page: number, x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height,
            screenX: event.clientX, screenY: event.clientY }
          clearTimeout(zoomTimer)
          zoomTimer = setTimeout(() => { void redraw().then(() => { if (!destroyed) onViewChange?.(viewSettings) }).catch(() => {}) }, 80)
        }, { passive: false })
        doc.addEventListener('mousedown', () => { swallowClick = false }, { capture: true })
        const consume = (event: Event): void => {
          if (event instanceof MouseEvent && event.button !== 0) return
          // 橡皮模式下拖选什么也不做,选区留给用户复制;荧光笔模式照常通知,
          // 由 ReaderView 存盘并清掉临时引用。
          if (readingTool === 'erase' || readingTool === 'pan') return
          const selection = doc.defaultView?.getSelection()
          if (!selections.size || !selection?.rangeCount || selection.isCollapsed) return
          const range = selection.getRangeAt(0)
          if (!view.selectableLayer!.contains(range.startContainer) || !view.selectableLayer!.contains(range.endContainer)) return
          const text = range.toString().trim()
          if (!text) return
          const cfi = new EpubCFI(range, base(number))
          const start = new EpubCFI(range, base(number)); start.collapse(true)
          selections.forEach((cb) => cb(cfi.toString(), text, null, start.toString()))
          selection.removeAllRanges()
          swallowClick = true
        }
        doc.addEventListener('mouseup', consume)
        doc.addEventListener('touchend', consume)
        doc.addEventListener('click', (event) => {
          if (swallowClick) { swallowClick = false; event.preventDefault(); return }
          if (readingTool === 'pan') return
          if (readPosition && event.button === 0) {
            const caret = doc.caretRangeFromPoint(event.clientX, event.clientY)
            if (caret?.startContainer.nodeType === Node.TEXT_NODE && view.selectableLayer!.contains(caret.startContainer)) {
              const remaining = doc.createRange()
              remaining.selectNodeContents(view.selectableLayer!)
              remaining.setStart(caret.startContainer, caret.startOffset)
              const text = [remaining.toString(), ...views.filter((v) => v.number > number).map((v) => v.text)]
                .join(' ').replace(/\s+/g, ' ').trim()
              if (text) { event.preventDefault(); readPosition(text); return }
            }
          }
          // 持久层优先:同一片文字上两层都有时,点的那一下归持久层(擦除整块),
          // 临时引用不受影响。
          for (const [cfi, id] of persistent) {
            const found = rangeFor(cfi)
            if (found?.view !== view) continue
            if (rangeRects(found.range).some((r) => event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom)) {
              persistentClick(id); return
            }
          }
          if (readingTool !== 'select') return
          for (const [cfi, onClick] of highlights) {
            const found = rangeFor(cfi)
            if (found?.view !== view) continue
            if (rangeRects(found.range).some((r) => event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom)) {
              onClick(); break
            }
          }
        })
        doc.addEventListener('keydown', onKey)
        doc.defaultView?.addEventListener('scroll', () => { rememberPosition(view); drawMarks() })
      }
      if (gen !== generation || destroyed) return
      // Capture at commit, not at render start: a user can keep scrolling while the next canvas is prepared.
      const centers = new Map<number, { x: number; y: number }>()
      if (preservePosition) for (const view of views) {
        rememberPosition(view)
        if (view.viewport) centers.set(view.number, view.viewport)
      }
      views.forEach(removePage)
      views = nextViews
      // Contrast may have changed while this frame was rendering; image styling
      // uses the latest value, so report that same value without another raster.
      renderedSettings = { ...settings, contrast: viewSettings.contrast }
      renderedSize = size
      views.forEach((v) => {
        v.doc.documentElement.classList.toggle('dark', theme === 'dark')
        v.doc.documentElement.classList.toggle('pan', readingTool === 'pan')
        applyImageStyle(v)
        v.frame.style.visibility = ''; v.frame.style.position = ''
        const center = centers.get(v.number) ?? (savedPosition?.page === v.number ? savedPosition : undefined)
        if (anchor?.page === v.number || center) {
          const rect = v.doc.querySelector('.page')!.getBoundingClientRect()
          const win = v.doc.defaultView!
          const point = anchor?.page === v.number ? anchor : center!
          win.scrollTo(rect.left + point.x * rect.width - (anchor?.page === v.number ? anchor.screenX : win.innerWidth / 2),
            rect.top + point.y * rect.height - (anchor?.page === v.number ? anchor.screenY : win.innerHeight / 2))
        }
        rememberPosition(v, true)
      })
      savedPosition = null
      if (zoomAnchor === anchor) zoomAnchor = null
      if (!targetCfi || pdfPageFromTarget(targetCfi, source.numPages) !== currentPage) targetCfi = views[0].start
      drawMarks()
      emit()
    } finally {
      if (views !== nextViews) nextViews.forEach(removePage)
    }
  }
  function redraw(preservePosition = true, resizeOnly = false): Promise<void> {
    drawing = drawing.catch(() => {}).then(() => {
      // A queued resize can arrive after an earlier render already fitted the viewport.
      // Do not replace that frame again (and discard an in-progress pointer capture).
      if (resizeOnly && !hasDisplayed) return
      if (resizeOnly && views.length && renderedSize.width === container.clientWidth && renderedSize.height === container.clientHeight) return
      return draw(preservePosition)
    })
    return drawing
  }
  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame)
    resizeFrame = requestAnimationFrame(() => { void redraw(true, true).catch(() => {}) })
  })
  observer.observe(container)

  return {
    async open(data, opts) {
      theme = opts.theme
      viewSettings = normalizePdfView(opts.pdfView)
      cachedOcr = opts.getPdfOcr
      onViewChange = opts.onPdfViewChange
      onPositionChange = opts.onPdfPositionChange
      savedPosition = opts.pdfPosition
      loading = loadPdf(data)
      try { pdf = await loading.promise } catch (error) { throw pdfError(error) }
      if (destroyed) { await loading.destroy(); return }
      const source = pdf
      const items = await source.getOutline()
      async function flatten(list: NonNullable<typeof items>, depth: number): Promise<void> {
        for (const item of list) {
          try {
            const dest = typeof item.dest === 'string' ? await source.getDestination(item.dest) : item.dest
            if (Array.isArray(dest)) {
              const page = typeof dest[0] === 'number' ? dest[0] + 1 : await source.getPageIndex(dest[0]) + 1
              outline.push({ label: item.title, href: `pdf-page-${page}`, depth })
            }
          } catch { /* A malformed outline entry does not prevent reading. */ }
          if (item.items?.length) await flatten(item.items, depth + 1)
        }
      }
      if (items) await flatten(items, 0)
    },
    async display(target) {
      if (!pdf) throw new Error('PDF 尚未打开')
      hasDisplayed = true
      if (target) {
        currentPage = pdfPageFromTarget(target, pdf.numPages)
        targetCfi = target.startsWith('epubcfi(') ? target : null
      }
      const restoringPosition = savedPosition?.page === currentPage
      await redraw(false)
      if (target?.startsWith('epubcfi(') && !restoringPosition) {
        const found = rangeFor(target)
        const rect = found?.range.getBoundingClientRect()
        if (found && rect && rect.height > 0) {
          const win = found.view.doc.defaultView!
          win.scrollBy(rect.left - win.innerWidth / 2, rect.top - win.innerHeight / 3)
          rememberPosition(found.view)
          drawMarks()
        }
      }
      // ReaderView's restoration gate expects a final relocation after display resolves.
      requestAnimationFrame(emit)
    },
    async next() { if (pdf && currentPage < pdf.numPages) { currentPage++; targetCfi = null; await redraw(false) } },
    async prev() { if (currentPage > 1) { currentPage--; targetCfi = null; await redraw(false) } },
    async setSpread(on) { spread = on; await redraw() },
    // Font size cannot change fixed-layout PDF. Viewport scaling has its own controls.
    setFontSize() {},
    async setPdfView(settings: PdfViewSettings) {
      const next = normalizePdfView(settings)
      clearTimeout(zoomTimer)
      // A contrast change can arrive while wheel zoom is pending. Preserve its
      // cursor anchor only when the requested zoom is still that same pending zoom.
      const samePendingZoom = next.mode === viewSettings.mode && (next.mode !== 'custom' || next.scale === viewSettings.scale)
      if (!samePendingZoom) zoomAnchor = null
      const contrastOnly = samePendingZoom && next.mode === renderedSettings.mode
        && (next.mode !== 'custom' || next.scale === views[0]?.scale) && views.length > 0
      viewSettings = next
      if (contrastOnly) { renderedSettings = { ...renderedSettings, contrast: next.contrast }; views.forEach(applyImageStyle); emit() }
      else await redraw()
    },
    getPdfView() {
      return { ...viewSettings, scale: viewSettings.mode === 'custom' ? viewSettings.scale : views[0]?.scale ?? viewSettings.scale }
    },
    async capturePdfPage(region, pageNumber = currentPage) {
      const source = pdf
      if (!source || destroyed) throw new Error('PDF 尚未打开')
      if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > source.numPages) throw new Error('PDF 页码无效')
      if (region && (![region.x, region.y, region.width, region.height].every(Number.isFinite) || region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0 || region.x + region.width > 1.000001 || region.y + region.height > 1.000001)) throw new Error('识别范围无效')
      const page = await source.getPage(pageNumber)
      const natural = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: Math.min(2, 16_384 / natural.width, 16_384 / natural.height,
        Math.sqrt(15_900_000 / (natural.width * natural.height))) })
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height)
      const task = page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport, background: '#ffffff' })
      captureTasks.add(task)
      let image = canvas
      try {
        await task.promise
        if (destroyed || source !== pdf) throw new Error('阅读器已关闭')
        if (region) {
          const left = Math.floor(region.x * canvas.width), top = Math.floor(region.y * canvas.height)
          image = document.createElement('canvas')
          image.width = Math.max(1, Math.min(canvas.width - left, Math.ceil(region.width * canvas.width)))
          image.height = Math.max(1, Math.min(canvas.height - top, Math.ceil(region.height * canvas.height)))
          image.getContext('2d')!.drawImage(canvas, left, top, image.width, image.height, 0, 0, image.width, image.height)
        }
        const blob = await new Promise<Blob>((resolve, reject) => image.toBlob((value) => value ? resolve(value) : reject(new Error('识别图像生成失败')), 'image/png'))
        return { page: pageNumber, image: await blob.arrayBuffer() }
      } finally {
        captureTasks.delete(task)
        canvas.width = 0; canvas.height = 0
        if (image !== canvas) { image.width = 0; image.height = 0 }
      }
    },
    onPdfRegion(cb) { regionListeners.add(cb); return () => { regionListeners.delete(cb) } },
    onPdfOcrNeeded(cb) { ocrNeeded.add(cb); return () => { ocrNeeded.delete(cb) } },
    async refreshPdfOcr() {
      // Add only immutable text nodes in-place: OCR must not replace a frame,
      // interrupt a drag, reset scroll or race an in-progress zoom render.
      await drawing.catch(() => {})
      await Promise.all(views.map(loadOcr))
      drawMarks(); emit()
    },
    selectPdfRegion(page, region) {
      const view = views.find(v => v.number === page)
      if (!view?.usesOcr || !selections.size) return false
      const rect = view.doc.querySelector('.page')!.getBoundingClientRect()
      const spans = Array.from(view.selectableLayer!.querySelectorAll('span')).filter(span => {
        const word = span.getBoundingClientRect()
        const x = (word.left + word.width / 2 - rect.left) / rect.width
        const y = (word.top + word.height / 2 - rect.top) / rect.height
        return x >= region.x && x <= region.x + region.width && y >= region.y && y <= region.y + region.height
      })
      if (!spans.length) return false
      const first = spans[0].firstChild!, last = spans.at(-1)!.firstChild!
      const range = view.doc.createRange(); range.setStart(first, 0); range.setEnd(last, last.textContent!.length)
      const start = new EpubCFI(range, base(page)); start.collapse(true)
      selections.forEach(cb => cb(new EpubCFI(range, base(page)).toString(), range.toString().trim(), null, start.toString()))
      return true
    },
    pdfOcrQuote(resultId) {
      for (const view of views) {
        const region = view.ocrQuotes?.get(resultId)
        if (region) return region
        const whole = view.doc.querySelector('.ocrLayer > div:first-child')
        if (view.usesOcr && whole?.childNodes.length && whole.getAttribute('data-result-id') === resultId) {
          return { cfiRange: makeRangeCfi(view.start, view.end), startCfi: view.start }
        }
      }
      return null
    },
    getPdfPosition() { for (const view of views) rememberPosition(view); return getPosition() },
    /**
     * 免渲染取页文本：已渲染的页直接复用其文本（与 getVisible 同一字符串），
     * 未渲染的页用 pdfjs 取文本层（与渲染/搜索同一提取公式），扫描页回退到
     * 已缓存的整页 OCR。只读：不改当前页/缩放/高亮/注释，不碰正文 DOM。
     */
    async getPageText(pageNo: number): Promise<string | null> {
      const rendered = views.find((v) => v.number === pageNo)
      if (rendered) return rendered.text.trim() ? rendered.text : null
      const source = pdf
      if (!source || destroyed) return null
      if (!Number.isInteger(pageNo) || pageNo < 1 || pageNo > source.numPages) return null
      try {
        const page = await source.getPage(pageNo)
        try {
          if (destroyed || pdf !== source) return null
          const content = await page.getTextContent()
          let text = content.items
            .map((item) => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '')
            .join('').trim()
          if (!text && cachedOcr) text = (await cachedOcr(pageNo)).find((r) => !r.region)?.text ?? ''
          return text.trim() ? text : null
        } finally {
          try {
            await (page as unknown as { cleanup?: () => unknown }).cleanup?.()
          } catch { /* 单页清理失败不影响已拿到的文本。 */ }
        }
      } catch {
        return null
      }
    },
    // PDF 是固定版式:行距/边距/字体预设不适用,空实现,界面侧直接隐藏排版面板。
    setTypography() {},
    setTheme(name) { theme = name; views.forEach((v) => { v.doc.documentElement.classList.toggle('dark', name === 'dark'); applyImageStyle(v) }); drawMarks() },
    async getVisible(): Promise<VisibleRange> {
      if (!views.length || !pdf) throw new Error('PDF 尚未显示')
      const first = views[0], last = views.at(-1)!
      const startCfi = first.start, endCfi = last.end
      // 段落与 text 同源：每页视觉行启发式组段后拼接，翻译按段落组装译文。
      const viewParagraphs = views.map((v) => splitPdfParagraphs(v.text))
      const paragraphs = viewParagraphs.flat()
      const text = views.map((v) => v.text).join('\n\n')
      return { text, startCfi, endCfi,
        rangeCfi: first === last ? makeRangeCfi(startCfi, endCfi) : '', approximate: false,
        paragraphs: paragraphs.length > 0 ? paragraphs : (text.trim() ? [text.trim()] : []),
        chapterHref: `pdf-page-${first.number}`, chapterLabel: outline.find((i) => i.href === `pdf-page-${first.number}`)?.label ?? `第 ${first.number} 页`,
        page: first.number, totalPages: pdf.numPages,
        readProgress: last.number === pdf.numPages ? 1 : (first.number - 1) / pdf.numPages,
        pdfView: { ...renderedSettings, scale: first.scale }, pdfOcr: !!first.usesOcr,
        pdfScanPages: views.filter((view) => view.isScan).map((view) => view.number),
        pdfMissingTextPages: views.filter((view) => !view.text).map((view) => view.number) }
    },
    toc: () => [...outline],
    currentCfi: () => targetCfi,
    exportLocations: () => null,
    /**
     * 当前 PDF 的文本层全文搜索。逐页 getTextContent() 取文本后复用
     * searchPdfPages() 做大小写不敏感匹配,只读:不改当前页/缩放/高亮/注释。
     * 扫描页(无文本层)自然无命中;单页损坏时跳过该页而不是整本报错。
     */
    async search(query: string): Promise<BookSearchResult[]> {
      const q = normalizeSearchQuery(query)
      const source = pdf
      if (!q || !source || destroyed) return []
      const labelForPage = (page: number): string =>
        outline.find((i) => i.href === `pdf-page-${page}`)?.label ?? `第 ${page} 页`
      const results: BookSearchResult[] = []
      const total = source.numPages
      for (let pageNo = 1; pageNo <= total; pageNo++) {
        if (results.length >= MAX_SEARCH_RESULTS || destroyed || pdf !== source) break
        try {
          const page = await source.getPage(pageNo)
          try {
            const content = await page.getTextContent()
            let text = content.items
              .map((item) => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '')
              .join('')
            if (!text.trim() && cachedOcr) text = (await cachedOcr(pageNo)).find((r) => !r.region)?.text ?? ''
            for (const hit of searchPdfPages([{ page: pageNo, text }], q, labelForPage, MAX_SEARCH_RESULTS)) {
              if (results.length >= MAX_SEARCH_RESULTS) break
              results.push(hit)
            }
          } finally {
            try {
              // 把该页的渲染缓存还回去,搜一遍大书不至于把内存顶满。
              await (page as unknown as { cleanup?: () => unknown }).cleanup?.()
            } catch { /* 单页清理失败不影响已拿到的命中。 */ }
          }
        } catch {
          // 单页损坏(文本层取不出来)只跳过该页,整本搜索继续。
        }
      }
      return results
    },
    onRelocated(cb) { relocated.add(cb); return () => { relocated.delete(cb) } },
    onKey(cb) { keys.add(cb); return () => { keys.delete(cb) } },
    onSelected(cb) { selections.add(cb); return () => { selections.delete(cb) } },
    onReadPosition(cb) { readPosition = cb; return () => { if (readPosition === cb) readPosition = null } },
    addHighlight(cfi, onClick) { highlights.set(cfi, onClick); drawMarks() },
    removeHighlight(cfi) { highlights.delete(cfi); drawMarks() },
    clearHighlights() { highlights.clear(); drawMarks() },
    setPersistentHighlights(items: PersistentHighlightItem[], onClick: (id: string) => void) {
      persistentClick = onClick
      persistent.clear()
      for (const item of items) {
        if (!persistent.has(item.cfiRange)) persistent.set(item.cfiRange, item.id)
      }
      drawMarks()
    },
    setReadingTool(tool: ReadingTool) {
      readingTool = tool
      views.forEach((v) => {
        v.cancelDrag?.()
        v.cancelHover?.()
        v.doc.querySelector<HTMLElement>('.page')!.style.cursor = tool === 'pan' ? 'grab' : 'text'
        v.doc.documentElement.classList.toggle('pan', tool === 'pan')
        if (tool !== 'pan') v.doc.documentElement.classList.remove('dragging')
      })
    },
    setAnnotations(items, onClick) { annotations = items; onAnnotationClick = onClick; drawMarks() },
    destroy() {
      destroyed = true; generation++
      observer.disconnect(); cancelAnimationFrame(resizeFrame)
      clearTimeout(positionTimer); clearTimeout(zoomTimer)
      window.removeEventListener('keydown', onKey)
      tasks.forEach((task) => task.cancel())
      captureTasks.forEach((task) => task.cancel()); captureTasks.clear()
      views.forEach(removePage); marks.forEach((m) => m.remove())
      views = []; marks = []
      relocated.clear(); keys.clear(); selections.clear(); highlights.clear()
      regionListeners.clear()
      ocrNeeded.clear()
      readPosition = null
      persistent.clear(); persistentClick = () => {}; readingTool = 'select'
      container.classList.remove('pdf-reader')
      void loading?.destroy().catch(() => {})
      pdf = null
    }
  }
}
