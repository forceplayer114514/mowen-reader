import { EpubCFI } from 'epubjs'
import { TextLayer, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist'
import pdfStyles from 'pdfjs-dist/web/pdf_viewer.css?inline'
import { loadPdf, pdfError } from './pdf'
import { makeRangeCfi } from './cfi'
import type { AnnotationMarker, BookSearchResult, PersistentHighlightItem, ReaderEngine, ReadingTool, SelectionPoint, ThemeName, TocItem, VisibleRange } from './types'
import { MAX_SEARCH_RESULTS, normalizeSearchQuery, searchPdfPages } from './types'

export { searchPdfPages, pdfExcerptForMatch } from './types'

interface PageView {
  number: number
  frame: HTMLIFrameElement
  doc: Document
  text: string
  start: string
  end: string
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
  let zoom = 1
  let theme: ThemeName = 'light'
  let outline: TocItem[] = []
  let views: PageView[] = []
  let generation = 0
  let destroyed = false
  let tasks: RenderTask[] = []
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
  container.classList.add('pdf-reader')

  function emit(): void { if (!destroyed) relocated.forEach((cb) => cb()) }
  function onKey(event: KeyboardEvent): void {
    const el = event.target as HTMLElement | null
    if (el?.closest('input, textarea, [contenteditable="true"]')) return
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

  function drawMarks(): void {
    marks.forEach((el) => el.remove())
    marks = []
    const host = container.getBoundingClientRect()
    function rectangles(cfi: string): DOMRect[] {
      const found = rangeFor(cfi)
      if (!found) return []
      const frame = found.view.frame.getBoundingClientRect()
      return Array.from(found.range.getClientRects()).filter((r) => r.width > 0 && r.height > 0)
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

  async function draw(): Promise<void> {
    if (!pdf || destroyed || container.clientWidth < 1 || container.clientHeight < 1) return
    const source = pdf
    const gen = ++generation
    tasks.forEach((task) => task.cancel())
    tasks = []
    const pages = spread && currentPage < source.numPages ? [currentPage, currentPage + 1] : [currentPage]
    const nextViews: PageView[] = []
    try {
      for (const number of pages) {
        const page = await source.getPage(number)
        if (gen !== generation || destroyed) return
        const natural = page.getViewport({ scale: 1 })
        const scale = Math.min((container.clientWidth / pages.length - 24) / natural.width, (container.clientHeight - 24) / natural.height) * zoom
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
        doc.write(`<!doctype html><html><head><meta charset="UTF-8"><style>${pdfStyles}\nhtml,body{margin:0;min-height:100%;background:transparent}body{display:grid;justify-content:center;align-content:start;padding:12px;box-sizing:border-box}.page{position:relative;flex:none;--scale-round-x:1px;--scale-round-y:1px}canvas{display:block}.textLayer{z-index:1}.textLayer ::selection{background:rgba(226,118,76,.4)}html.dark canvas{filter:invert(.9) hue-rotate(180deg)}</style></head><body><div class="page"><canvas></canvas><div class="textLayer"></div></div></body></html>`)
        doc.close()
        nextViews.push({ number, frame, doc, text: '', start: '', end: '' })
        const view = nextViews.at(-1)!
        doc.documentElement.classList.toggle('dark', theme === 'dark')
        const wrapper = doc.querySelector<HTMLElement>('.page')!
        wrapper.style.width = `${viewport.width}px`
        wrapper.style.height = `${viewport.height}px`
        wrapper.style.setProperty('--total-scale-factor', String(viewport.scale))
        const canvas = doc.querySelector('canvas')!
        const ratio = Math.min(2, window.devicePixelRatio || 1)
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
        view.text = content.items.map((item) => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '').join('').trim()
        const nodes: Text[] = []
        const walker = doc.createTreeWalker(layer, NodeFilter.SHOW_TEXT)
        while (walker.nextNode()) nodes.push(walker.currentNode as Text)
        const first = nodes[0], last = nodes.at(-1)
        if (first && last) {
          const range = doc.createRange()
          range.setStart(first, 0)
          range.setEnd(last, last.length)
          const start = new EpubCFI(range, base(number)), end = new EpubCFI(range, base(number))
          start.collapse(true); end.collapse(false)
          view.start = start.toString(); view.end = end.toString()
        } else {
          view.start = `epubcfi(${base(number)}!/4:0)`
          view.end = `epubcfi(${base(number)}!/4:1)`
        }
        let swallowClick = false
        doc.addEventListener('mousedown', () => { swallowClick = false }, { capture: true })
        const consume = (event: Event): void => {
          if (event instanceof MouseEvent && event.button !== 0) return
          // 橡皮模式下拖选什么也不做,选区留给用户复制;荧光笔模式照常通知,
          // 由 ReaderView 存盘并清掉临时引用。
          if (readingTool === 'erase') return
          const selection = doc.defaultView?.getSelection()
          if (!selections.size || !selection?.rangeCount || selection.isCollapsed) return
          const range = selection.getRangeAt(0)
          if (!layer.contains(range.startContainer) || !layer.contains(range.endContainer)) return
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
          if (readPosition && event.button === 0) {
            const caret = doc.caretRangeFromPoint(event.clientX, event.clientY)
            if (caret?.startContainer.nodeType === Node.TEXT_NODE && layer.contains(caret.startContainer)) {
              const remaining = doc.createRange()
              remaining.selectNodeContents(layer)
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
            if (Array.from(found.range.getClientRects()).some((r) => event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom)) {
              persistentClick(id); return
            }
          }
          if (readingTool !== 'select') return
          for (const [cfi, onClick] of highlights) {
            const found = rangeFor(cfi)
            if (found?.view !== view) continue
            if (Array.from(found.range.getClientRects()).some((r) => event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom)) {
              onClick(); break
            }
          }
        })
        doc.addEventListener('keydown', onKey)
        doc.defaultView?.addEventListener('scroll', drawMarks)
      }
      if (gen !== generation || destroyed) return
      views.forEach((v) => v.frame.remove())
      views = nextViews
      views.forEach((v) => {
        v.doc.documentElement.classList.toggle('dark', theme === 'dark')
        v.frame.style.visibility = ''; v.frame.style.position = ''
      })
      if (!targetCfi || pdfPageFromTarget(targetCfi, source.numPages) !== currentPage) targetCfi = views[0].start
      drawMarks()
      emit()
    } finally {
      if (views !== nextViews) nextViews.forEach((v) => v.frame.remove())
    }
  }
  function redraw(): Promise<void> {
    drawing = drawing.catch(() => {}).then(draw)
    return drawing
  }
  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame)
    resizeFrame = requestAnimationFrame(() => { void redraw().catch(() => {}) })
  })
  observer.observe(container)

  return {
    async open(data, opts) {
      theme = opts.theme
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
      if (target) {
        currentPage = pdfPageFromTarget(target, pdf.numPages)
        targetCfi = target.startsWith('epubcfi(') ? target : null
      }
      await redraw()
      // ReaderView's restoration gate expects a final relocation after display resolves.
      requestAnimationFrame(emit)
    },
    async next() { if (pdf && currentPage < pdf.numPages) { currentPage++; targetCfi = null; await redraw() } },
    async prev() { if (currentPage > 1) { currentPage--; targetCfi = null; await redraw() } },
    async setSpread(on) { spread = on; await redraw() },
    async setFontSize(px) { zoom = px / 18; await redraw() },
    // PDF 是固定版式:行距/边距/字体预设不适用,空实现,界面侧直接隐藏排版面板。
    setTypography() {},
    setTheme(name) { theme = name; views.forEach((v) => v.doc.documentElement.classList.toggle('dark', name === 'dark')); drawMarks() },
    async getVisible(): Promise<VisibleRange> {
      if (!views.length || !pdf) throw new Error('PDF 尚未显示')
      const first = views[0], last = views.at(-1)!
      const startCfi = first.start, endCfi = last.end
      return { text: views.map((v) => v.text).join('\n\n'), startCfi, endCfi,
        rangeCfi: first === last ? makeRangeCfi(startCfi, endCfi) : '', approximate: false,
        chapterHref: `pdf-page-${first.number}`, chapterLabel: outline.find((i) => i.href === `pdf-page-${first.number}`)?.label ?? `第 ${first.number} 页`,
        page: first.number, totalPages: pdf.numPages,
        readProgress: last.number === pdf.numPages ? 1 : (first.number - 1) / pdf.numPages }
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
            const text = content.items
              .map((item) => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '')
              .join('')
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
    setReadingTool(tool: ReadingTool) { readingTool = tool },
    setAnnotations(items, onClick) { annotations = items; onAnnotationClick = onClick; drawMarks() },
    destroy() {
      destroyed = true; generation++
      observer.disconnect(); cancelAnimationFrame(resizeFrame)
      window.removeEventListener('keydown', onKey)
      tasks.forEach((task) => task.cancel())
      views.forEach((v) => v.frame.remove()); marks.forEach((m) => m.remove())
      views = []; marks = []
      relocated.clear(); keys.clear(); selections.clear(); highlights.clear()
      readPosition = null
      persistent.clear(); persistentClick = () => {}; readingTool = 'select'
      container.classList.remove('pdf-reader')
      void loading?.destroy().catch(() => {})
      pdf = null
    }
  }
}
