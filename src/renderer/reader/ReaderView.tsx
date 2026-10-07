import { useCallback, useEffect, useRef, useState } from 'react'
import type { BookmarkRecord, BookRecord, QuoteRecord } from '@shared/types'
import type { HighlightRecord } from '@shared/highlight-types'
import type { PdfOcrLanguage, PdfOcrProgress, PdfOcrRegion } from '@shared/pdf-ocr-types'
import TocPanel from './TocPanel'
import { conversationsOnPage } from './anchor'
import { createEngine } from './engine'
import { createPdfEngine } from './pdf-engine'
import { textToEpub } from './text-book'
import { bookFormat } from '@shared/book-format'
import { nextPdfPage, normalizeBookText, splitPdfParagraphs } from '@shared/book-translation'
import { createSelectionStore, type SelectionStore } from './selection'
import type { BookSearchResult, FontFamilyName, PageMarginName, PdfViewSettings, ReaderEngine, ReadingTool, ThemeName, TocItem, TypographyOptions, VisibleRange } from './types'
import {
  DEFAULT_SHORTCUTS,
  DEFAULT_TYPOGRAPHY,
  LINE_HEIGHT_PRESETS,
  normalizeShortcutKey,
  normalizePdfView,
  normalizeTypography,
  validateShortcutMapping
} from './types'
import Sidebar from '../chat/Sidebar'
import ConfirmDialog from '../ConfirmDialog'
import ReadAloud from './ReadAloud'
import { useBookTranslation } from './useBookTranslation'

const FONT_MIN = 14
const FONT_MAX = 28
const PDF_SCALES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]
/** 恢复阅读位置时,校验落点最多重试这么多次(见 boot() 里的用法和注释)。 */
const MAX_POSITION_VERIFY_ATTEMPTS = 3
/** 打开书之后一直拿不到一次成功的 getVisible(),等这么久就判定书是真的读不出来。 */
const VISIBLE_STUCK_TIMEOUT_MS = 5000

export interface RestoreRelocationGate {
  readonly restoring: boolean
  finishDisplay(): void
  cancel(): void
  consumeRelocation(): boolean
}

/** Keep the UI in restore mode until epub.js emits the relocation caused by display(). */
export function createRestoreRelocationGate(active: boolean): RestoreRelocationGate {
  let restoring = active
  let awaitingRelocation = false
  return {
    get restoring() { return restoring },
    finishDisplay() {
      if (!active) return
      restoring = false
      awaitingRelocation = true
    },
    cancel() {
      restoring = false
      awaitingRelocation = false
    },
    consumeRelocation() {
      if (!awaitingRelocation) return false
      awaitingRelocation = false
      return true
    }
  }
}

/** 等下一帧再继续——给 epub.js 一点时间把刚创建窗口时还没定型的排版尺寸重新测量一遍。 */
function waitForFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

/**
 * 仅端到端测试使用的两个 window 字段,和书架那边的 __E2E_FILES__ 是同一个路子。
 * 划选引用要等侧边栏那个任务才会被真正接进界面,在那之前页面上没有任何人订阅
 * onSelected;而引擎的划选、加高亮、点高亮取消、换主题重画这几条路只有在真实的
 * EPUB 和真实的 iframe 里才试得出来,单元测试那边的假引擎根本碰不到。测试先把
 * __E2E_SELECTION__ 置上再打开书,下面才会建一个真的 selection store 订上去,
 * 并把它的引用列表通过 __E2E_QUOTES__ 暴露出来供断言。正常运行时这个标记不存在,
 * 什么都不会建、也什么都不会暴露。
 */
interface SelectionTestHooks {
  __E2E_SELECTION__?: boolean
  __E2E_QUOTES__?: () => QuoteRecord[]
  __E2E_FILES__?: string[]
}

interface Props {
  book: BookRecord
  onBack: () => void
  theme: ThemeName
  onToggleTheme: () => void
}

export default function ReaderView({ book, onBack, theme, onToggleTheme }: Props) {
  const format = bookFormat(book.filePath) ?? 'epub'
  const isPdf = format === 'pdf'
  const hostRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<ReaderEngine | null>(null)
  const [visible, setVisible] = useState<VisibleRange | null>(null)
  const [toc, setToc] = useState<TocItem[]>([])
  const [showToc, setShowToc] = useState(false)
  // 书内全文搜索:面板开关、查询、命中列表与当前高亮下标。
  // 只读操作,分页/进度/高亮/注释一概不动,跳转复用 engine.display()。
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<BookSearchResult[]>([])
  const [searchIndex, setSearchIndex] = useState(0)
  const [searchBusy, setSearchBusy] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searchTouched, setSearchTouched] = useState(false)
  // 搜索异步代际:切书/关面板/改查询时自增,在途的旧查询回来自觉丢弃。
  const searchGenRef = useRef(0)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const searchToggleRef = useRef<HTMLButtonElement>(null)
  const [fontSize, setFontSize] = useState(18)
  const pdfTargetRef = useRef<PdfViewSettings | null>(null)
  const pdfView = visible?.pdfView ?? normalizePdfView(null)
  const pdfScale = Math.round(pdfView.scale * 100) / 100
  const scanPage = isPdf && Boolean(visible && !visible.text.trim())
  const missingPdfText = isPdf ? visible?.pdfMissingTextPages ?? [] : []
  const [ocrLanguage, setOcrLanguage] = useState<PdfOcrLanguage>('chi_sim+eng')
  const [ocrBusy, setOcrBusy] = useState(false)
  const [ocrProgress, setOcrProgress] = useState<PdfOcrProgress | null>(null)
  const [ocrError, setOcrError] = useState<string | null>(null)
  const [ocrSourcePage, setOcrSourcePage] = useState(0)
  const ocrRequestRef = useRef<{ id: string; page: number; language: PdfOcrLanguage; region?: PdfOcrRegion; selection?: PdfOcrRegion } | null>(null)
  const ocrSettledRef = useRef<Promise<void>>(Promise.resolve())
  const ocrAttemptedRef = useRef(new Set<string>())
  const ocrRetryRef = useRef<{ page: number; region?: PdfOcrRegion } | null>(null)
  // 排版预设(EPUB/TXT 三档小面板):行距/页边距/字体;PDF 固定版式不受影响,面板直接隐藏。
  // 存盘键见 db/settings.ts 白名单(lineHeight/pageMargin/fontFamily),读回非法值退回默认。
  const [typography, setTypographyState] = useState<TypographyOptions>({ ...DEFAULT_TYPOGRAPHY })
  const [showTypography, setShowTypography] = useState(false)
  const targetTypoRef = useRef<TypographyOptions>({ ...DEFAULT_TYPOGRAPHY })
  const appliedTypoRef = useRef<TypographyOptions>({ ...DEFAULT_TYPOGRAPHY })
  // 快捷键帮助与两项可配置映射(目录/书签开关,无修饰单键,不占 Ctrl/方向键/Esc)。
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [shortcutToc, setShortcutToc] = useState<string>(DEFAULT_SHORTCUTS.toggleToc)
  const [shortcutBookmark, setShortcutBookmark] = useState<string>(DEFAULT_SHORTCUTS.toggleBookmark)
  const [shortcutError, setShortcutError] = useState<string | null>(null)
  const shortcutTocRef = useRef<string>(DEFAULT_SHORTCUTS.toggleToc)
  const shortcutBookmarkRef = useRef<string>(DEFAULT_SHORTCUTS.toggleBookmark)
  const shortcutTocInputRef = useRef<HTMLInputElement>(null)
  const shortcutBookmarkInputRef = useRef<HTMLInputElement>(null)
  const themeRef = useRef(theme)
  themeRef.current = theme
  const [error, setError] = useState<string | null>(null)
  const [statsError, setStatsError] = useState<string | null>(null)
  const [selectionStore, setSelectionStore] = useState<SelectionStore | null>(null)
  const [readerEngine, setReaderEngine] = useState<ReaderEngine | null>(null)
  const [spread, setSpread] = useState(false)
  const [restoring, setRestoring] = useState(Boolean(book.lastReadCfi))
  const [bookmarks, setBookmarks] = useState<BookmarkRecord[]>([])
  const [bookmarkError, setBookmarkError] = useState<string | null>(null)
  const [deletingBookmarkId, setDeletingBookmarkId] = useState<string | null>(null)
  const bookmarkDeletingRef = useRef(false)
  // 持久荧光笔:工具三选一,存盘列表是真相,引擎只负责画出来。
  const [readingTool, setReadingToolState] = useState<ReadingTool>('select')
  const toolRef = useRef<ReadingTool>('select')
  // 快捷键回调要一个引用稳定的书签切换,里面永远走最新的 visible(见 eraseRef 同例)。
  const toggleBookmarkRef = useRef<() => Promise<void>>(async () => {})
  const [highlights, setHighlights] = useState<HighlightRecord[]>([])
  const [highlightsReady, setHighlightsReady] = useState(false)
  const highlightsRef = useRef<HighlightRecord[]>([])
  const [highlightError, setHighlightError] = useState<string | null>(null)
  const [lastErased, setLastErased] = useState<HighlightRecord | null>(null)
  const lastErasedRef = useRef<HighlightRecord | null>(null)
  // 高亮异步代际:开书/切书/卸载/每次存删时自增,在途的读写发现代际变了就丢弃结果。
  const hlGenRef = useRef(0)
  const [annotationState, setAnnotationState] = useState({ dirty: false, saving: false })
  const [confirmLeave, setConfirmLeave] = useState(false)
  const updateAnnotationState = useCallback((dirty: boolean, saving: boolean) => {
    setAnnotationState({ dirty, saving })
  }, [])
  const spreadRef = useRef(false)
  const fontChainRef = useRef<Promise<void>>(Promise.resolve())
  const anchorCfiRef = useRef<string | null>(null)
  const layoutAnchorCfiRef = useRef<string | null>(null)
  const clearLayoutAnchor = useCallback(() => {
    layoutAnchorCfiRef.current = null
    anchorCfiRef.current = null
  }, [])
  const targetFontRef = useRef<number>(18)
  const appliedFontRef = useRef<number>(18)
  // 整书 AI 翻译：书架按书独立手动开启，默认关闭；阅读页点“开始翻译”后逐分句增量翻译。
  const [translationEnabled, setTranslationEnabled] = useState(Boolean(book.translationEnabled))
  const [translationStarted, setTranslationStarted] = useState(false)
  const [translationView, setTranslationView] = useState<'original' | 'translated'>('original')
  // 预取回调与影子引擎要用的最新正文/书字节：放 ref 里，回调保持引用稳定。
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const bookDataRef = useRef<ArrayBuffer | null>(null)
  // 阅读页直接开关本书翻译（与书架开关同一落盘位，按书独立；关不断缓存）。
  const [translationToggling, setTranslationToggling] = useState(false)
  const toggleTranslationEnabled = useCallback(async () => {
    if (translationToggling) return
    setTranslationToggling(true)
    try {
      const next = await window.api.setBookTranslationEnabled(book.id, !translationEnabled)
      setTranslationEnabled(next)
      // 关即回原文；重开时按会话意图恢复译文（started 保留，缓存即时组装）。
      if (!next) setTranslationView('original')
      else if (translationStarted) setTranslationView('translated')
    } catch {
      setError('翻译开关保存失败，请重试')
    } finally {
      setTranslationToggling(false)
    }
  }, [book.id, translationEnabled, translationStarted, translationToggling])
  const peekNextPageParagraphs = useCallback(async (): Promise<string[] | null> => {
    const engine = engineRef.current
    const current = visibleRef.current
    if (!engine || !current) return null
    try {
      if (isPdf) {
        // PDF 版式固定：直接读下一物理页文本，不翻页、不渲染。
        const next = nextPdfPage(current, true)
        if (next === null) return null
        const text = await engine.getPageText?.(next)
        if (!text || !normalizeBookText(text)) return null
        const paragraphs = splitPdfParagraphs(text)
        return paragraphs.length > 0 ? paragraphs : null
      }
      // EPUB/TXT 重排页：影子引擎在同样尺寸下独立翻到下一页，主引擎不动
      // （无闪烁、不污染阅读进度与对话上下文；缓存是追加写入，不存在竞态）。
      // 盒模型必须与主容器逐项一致（border-box 尺寸 + 内边距），否则量出的分页
      // 与主引擎差几行，预取的文本就对不上用户翻页后看到的，复用率大跌。
      const host = hostRef.current
      const hostWidth = host?.clientWidth ?? 0
      const hostHeight = host?.clientHeight ?? 0
      const bytes = bookDataRef.current
      if (!bytes || hostWidth < 1 || hostHeight < 1) return null
      const anchor = engine.currentCfi()
      if (!anchor) return null
      const computed = host ? getComputedStyle(host) : null
      const ghost = document.createElement('div')
      ghost.setAttribute('aria-hidden', 'true')
      Object.assign(ghost.style, {
        position: 'fixed', left: '-30000px', top: '0px',
        width: `${hostWidth}px`, height: `${hostHeight}px`,
        padding: computed?.padding ?? '0px',
        boxSizing: computed?.boxSizing ?? 'content-box',
        border: 'none', margin: '0px', visibility: 'hidden'
      })
      document.body.appendChild(ghost)
      // 影子 open 会覆盖调试用的全局引擎引用，结束后原样还回去。
      const prevRendition = (window as unknown as { __readerRendition?: unknown }).__readerRendition
      const prevBook = (window as unknown as { __readerBook?: unknown }).__readerBook
      let ghostEngine: ReaderEngine | null = null
      try {
        ghostEngine = createEngine(ghost)
        await ghostEngine.open(bytes.slice(0), {
          fontSize: targetFontRef.current,
          theme: themeRef.current,
          savedLocations: engine.exportLocations(),
          typography: { ...targetTypoRef.current }
        })
        // display() resolve 早于 epub.js 的最终 relocated（见 boot 注释同例）：
        // 轮询到 getVisible() 成功为止，否则紧接着的 next() 会空转。
        const ghostVisible = async (timeoutMs: number): Promise<VisibleRange | null> => {
          const start = Date.now()
          for (;;) {
            try {
              return await ghostEngine!.getVisible()
            } catch {
              if (Date.now() - start > timeoutMs) return null
              await new Promise((r) => setTimeout(r, 60))
            }
          }
        }
        await ghostEngine.display(anchor)
        const before = await ghostVisible(3000)
        if (!before) return null
        // next() 翻页是异步的：立刻 getVisible() 读回的还是旧位置，必须轮询到
        // startCfi 变化为止；超时说明已在末页（或翻不动），返回 null。
        for (let attempt = 0; attempt < 2; attempt++) {
          await ghostEngine.next()
          const deadline = Date.now() + 2000
          for (;;) {
            const after = await ghostVisible(Math.max(0, deadline - Date.now()))
            if (!after) return null
            if (after.startCfi !== before.startCfi) {
              const paragraphs = (after.paragraphs ?? []).map((p) => normalizeBookText(p)).filter(Boolean)
              if (paragraphs.length > 0) return paragraphs
              const fallback = normalizeBookText(after.text)
              return fallback ? [fallback] : null
            }
            if (Date.now() >= deadline) break
            await new Promise((r) => setTimeout(r, 80))
          }
        }
        return null
      } finally {
        try { ghostEngine?.destroy() } catch { /* 影子引擎销毁失败不影响正文 */ }
        ghost.remove()
        ;(window as unknown as { __readerRendition?: unknown }).__readerRendition = prevRendition
        ;(window as unknown as { __readerBook?: unknown }).__readerBook = prevBook
      }
    } catch {
      return null
    }
  }, [isPdf, book.id])
  const translation = useBookTranslation({
    bookId: book.id,
    enabled: translationEnabled,
    started: translationStarted,
    visible,
    isPdf,
    peekNextPageParagraphs,
    peekAllowed: Boolean(visible && !restoring && readerEngine)
  })

  // 正文成功显示后计时；字号/位置等保存失败不代表用户停止阅读。
  const readingReady = Boolean(visible && !restoring)
  useEffect(() => {
    const unsubscribe = window.api.onReadingStatsError(setStatsError)
    void window.api.setReadingBook(readingReady ? book.id : null).catch(() => setStatsError('阅读计时启动失败，请重新打开本书'))
    return () => {
      unsubscribe()
      void window.api.setReadingBook(null).catch(() => {})
    }
  }, [book.id, readingReady])

  useEffect(() => {
    readerEngine?.setTheme(theme)
  }, [readerEngine, theme])

  // 切书时搜索状态清零,在途的旧书查询回来直接丢弃,不混进新书。
  useEffect(() => {
    searchGenRef.current++
    setSearchOpen(false)
    setSearchQuery('')
    setSearchResults([])
    setSearchIndex(0)
    setSearchBusy(false)
    setSearchError(null)
    setSearchTouched(false)
  }, [book.id])

  // 切书时翻译状态清零；开关以库为准（书架上传入的 prop 可能滞后），默认关闭、按书独立。
  useEffect(() => {
    let cancelled = false
    setTranslationEnabled(Boolean(book.translationEnabled))
    setTranslationStarted(false)
    setTranslationView('original')
    void window.api.getBookTranslationEnabled(book.id).then((enabled) => {
      if (!cancelled) {
        setTranslationEnabled(enabled)
        if (!enabled) {
          setTranslationStarted(false)
          setTranslationView('original')
        }
      }
    }).catch(() => {})
    return () => { cancelled = true }
  }, [book.id, book.translationEnabled])

  const closeSearch = useCallback(() => {
    searchGenRef.current++
    setSearchOpen(false)
    setSearchBusy(false)
    setSearchError(null)
    // 焦点回到打开面板的那个按钮,键盘用户不至于丢位置。
    searchToggleRef.current?.focus()
  }, [])

  const openSearch = useCallback(() => {
    setSearchOpen(true)
  }, [])

  // Ctrl/Cmd+F 打开书内搜索,代替浏览器默认的页面查找(阅读区是 iframe 分页,
  // 浏览器自带查找跨页即失效,必须由引擎按 CFI/页码定位)。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 面板打开即把焦点送进输入框;关闭由 closeSearch 负责送回,不在这里抢。
  useEffect(() => {
    if (!searchOpen) return
    const frame = requestAnimationFrame(() => {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [searchOpen])

  // 查询变化后防抖搜索:引擎就绪前输入的内容等引擎就绪自动跑一次,不吞查询。
  useEffect(() => {
    if (!searchOpen) return
    const q = searchQuery.trim()
    if (!q) {
      searchGenRef.current++
      setSearchResults([])
      setSearchIndex(0)
      setSearchBusy(false)
      setSearchError(null)
      setSearchTouched(false)
      return
    }
    setSearchBusy(true)
    setSearchResults([])
    setSearchIndex(0)
    const gen = ++searchGenRef.current
    const timer = setTimeout(() => {
      const engine = engineRef.current
      if (!engine) return
      engine.search(q).then((hits) => {
        if (gen !== searchGenRef.current) return
        setSearchResults(hits)
        setSearchIndex(0)
        setSearchBusy(false)
        setSearchError(null)
        setSearchTouched(true)
      }).catch(() => {
        if (gen !== searchGenRef.current) return
        setSearchBusy(false)
        setSearchError('书内搜索失败,请稍后重试')
        setSearchTouched(true)
      })
    }, 250)
    return () => clearTimeout(timer)
  }, [searchOpen, searchQuery, readerEngine])

  const goToSearchResult = useCallback((idx: number) => {
    const hit = searchResults[idx]
    if (!hit) return
    setSearchIndex(idx)
    setSearchError(null)
    clearLayoutAnchor()
    engineRef.current?.display(hit.cfiRange).catch(() => {
      setSearchError('跳转到搜索结果失败,目标位置可能已移动')
    })
  }, [searchResults, clearLayoutAnchor])

  const stepSearch = useCallback((delta: number) => {
    if (searchResults.length === 0) return
    goToSearchResult((searchIndex + delta + searchResults.length) % searchResults.length)
  }, [searchResults, searchIndex, goToSearchResult])

  useEffect(() => {
    let cancelled = false
    void window.api.listBookmarks(book.id).then((loaded) => {
      if (!cancelled) setBookmarks(loaded)
    }).catch(() => {
      if (!cancelled) setBookmarkError('书签读取失败，请稍后重试')
    })
    return () => { cancelled = true }
  }, [book.id])

  const currentBookmark = visible
    ? conversationsOnPage(bookmarks, visible.startCfi, visible.endCfi)[0]
    : undefined

  const setSpreadMode = useCallback(async (on: boolean): Promise<void> => {
    const current = engineRef.current
    if (!current) return
    clearLayoutAnchor()
    await current.setSpread(on)
    spreadRef.current = on
    setSpread(on)
  }, [clearLayoutAnchor])

  const next = useCallback(() => {
    const current = engineRef.current
    if (!current) return
    if (spreadRef.current) {
      clearLayoutAnchor()
      void current.setSpread(false).then(() => current.next()).then(() => {
        spreadRef.current = false
        setSpread(false)
      }).catch(() => setError('收回双页失败，请稍后重试'))
      return
    }
    fontChainRef.current = fontChainRef.current.then(async () => {
      clearLayoutAnchor()
      await current.next()
    }).catch(() => {})
  }, [clearLayoutAnchor])

  const prev = useCallback(() => {
    const current = engineRef.current
    if (!current) return
    if (spreadRef.current) {
      clearLayoutAnchor()
      void current.setSpread(false).then(() => {
        spreadRef.current = false
        setSpread(false)
      }).catch(() => setError('收回双页失败，请稍后重试'))
      return
    }
    fontChainRef.current = fontChainRef.current.then(async () => {
      clearLayoutAnchor()
      await current.prev()
    }).catch(() => {})
  }, [clearLayoutAnchor])

  // 开书:读设置 → 读文件 → 渲染 → 跳到上次位置
  useEffect(() => {
    setRestoring(Boolean(book.lastReadCfi))
    let cancelled = false
    let engine: ReaderEngine | null = null
    let selectionStore: ReturnType<typeof createSelectionStore> | null = null
    let unsubscribeRelocated: (() => void) | null = null
    let unsubscribeKey: (() => void) | null = null
    let stuckTimer: ReturnType<typeof setTimeout> | null = null
    let hasVisible = false

    // 切书时把上一本书的荧光笔状态清掉,并让上一本书在途的高亮读写失效。
    hlGenRef.current++
    highlightsRef.current = []
    setHighlights([])
    setHighlightsReady(false)
    lastErasedRef.current = null
    setLastErased(null)
    setHighlightError(null)
    toolRef.current = 'select'
    setReadingToolState('select')
    pdfTargetRef.current = null

    function clearStuckTimer(): void {
      if (stuckTimer !== null) {
        clearTimeout(stuckTimer)
        stuckTimer = null
      }
    }

    // 拿到一次成功的 getVisible() 结果统一走这里:标记"已经成功过"并撤掉兜底的
    // 超时提示,避免一本能正常读的书只是稍微慢一点,就被误判成"打不开"。
    function handleVisible(v: VisibleRange): void {
      hasVisible = true
      clearStuckTimer()
      if (!cancelled) {
        setError((prev) =>
          prev === '书本内容长时间无法显示,可能是文件已损坏' ? null : prev
        )
        setVisible(v)
      }
    }

    // 恢复上次读到的位置期间(见下面 boot() 里 book.lastReadCfi 那一段)先landing
    // 一次、再校验、必要时重新 display() 的整个过程都算"恢复进行中"。这段时间里
    // onRelocated 触发的每一次 relocate 都不是用户翻页翻出来的,不能当成新的阅读
    // 位置写回数据库——校验循环重试到一半、机器慢或书大导致最终放弃时,最后落定的
    // 位置往往比 book.lastReadCfi 更靠前,如果照常保存,书签就会被这次没验证通过的
    // 落点悄悄往回带,下次打开再触发一次同样的偏差,一次比一次靠前。这个标记只在
    // 存在 book.lastReadCfi 时才需要置为 true(全新的书没有可恢复的位置,不存在
    // 这个问题)。display() resolve 只代表渲染完成,最终 relocated 还在后面的队列里;
    // restoreGate 会把恢复保护延续到那次通知,避免 Sidebar 在同一事件里误切换对话。
    const restoreGate = createRestoreRelocationGate(Boolean(book.lastReadCfi))

    async function boot(): Promise<void> {
      if (!hostRef.current) return
      try {
        const savedFont = isPdf ? 18 : Number((await window.api.getSetting('fontSize')) ?? 18)
        const savedPdfView = isPdf ? normalizePdfView(await window.api.getSetting('pdfView')) : undefined
        const savedPdfPosition = isPdf ? await window.api.getPdfPosition(book.id) : null
        // 排版预设只对 EPUB/TXT 读盘:PDF 固定版式不受影响,也不让旧脏数据污染界面。
        const savedTypo: TypographyOptions = isPdf ? { ...DEFAULT_TYPOGRAPHY } : normalizeTypography({
          lineHeight: await window.api.getSetting('lineHeight'),
          margin: await window.api.getSetting('pageMargin'),
          fontFamily: await window.api.getSetting('fontFamily')
        })
        let savedTocKey = normalizeShortcutKey(await window.api.getSetting('shortcutToc'), DEFAULT_SHORTCUTS.toggleToc)
        let savedBmKey = normalizeShortcutKey(await window.api.getSetting('shortcutBookmark'), DEFAULT_SHORTCUTS.toggleBookmark)
        // 存盘的两项撞键(历史脏数据)时书签退回备用键,保证开书即用、不等用户先修。
        if (savedTocKey === savedBmKey) savedBmKey = savedTocKey === 'b' ? 'n' : 'b'
        if (cancelled) return
        targetTypoRef.current = { ...savedTypo }
        appliedTypoRef.current = { ...savedTypo }
        setTypographyState(savedTypo)
        shortcutTocRef.current = savedTocKey
        shortcutBookmarkRef.current = savedBmKey
        setShortcutToc(savedTocKey)
        setShortcutBookmark(savedBmKey)
        const savedLocations = await window.api.getLocations(book.id)
        const original = await window.api.readBookFile(book.id)
        const data = format === 'txt' ? await textToEpub(original, book.title) : original
        if (cancelled) return
        // 影子引擎预取下一页时复用同一份书字节（打开时再 slice 拷贝，不与主引擎争用）。
        bookDataRef.current = data

        engine = isPdf ? createPdfEngine(hostRef.current) : createEngine(hostRef.current)
        engineRef.current = engine

        // 侧边栏与正文共用一个临时选区 store。端到端测试额外通过同一 store
        // 暴露引用列表,不改变正常运行路径。
        const hooks = window as unknown as SelectionTestHooks
        // 旧的 Task 8 回归用例明确验证“没有消费者时保留原生选区”。生产环境没有
        // __E2E_FILES__,因此仍会创建真实 store；只有该回归用例的测试文件标记存在
        // 且没有主动 enableSelectionStore 时才保留无消费者路径。
        const shouldCreateStore = !hooks.__E2E_FILES__ || Boolean(hooks.__E2E_SELECTION__)
        const store = shouldCreateStore ? createSelectionStore(engine, () => toolRef.current === 'select') : null
        selectionStore = store
        setSelectionStore(store)
        if (store && hooks.__E2E_SELECTION__) {
          hooks.__E2E_QUOTES__ = () => store.list()
        }
        engine.setReadingTool(toolRef.current)
        // 存盘的完整列表和引擎渲染无关,并发去读;画页面由上面的 effect 整表推送。
        // 普通划选与注释不受影响,新旧列表都只含本书记下的 CFI 范围。
        const listGen = hlGenRef.current
        void window.api.listHighlights(book.id).then((loaded) => {
          if (cancelled || listGen !== hlGenRef.current) return
          highlightsRef.current = loaded
          setHighlights(loaded)
          setHighlightsReady(true)
        }).catch(() => {
          if (!cancelled && listGen === hlGenRef.current) setHighlightError('荧光笔读取失败，请返回书架后重新打开本书重试')
        })
        const initialFont = Number.isFinite(savedFont) ? savedFont : 18
        targetFontRef.current = initialFont
        appliedFontRef.current = initialFont
        setFontSize(initialFont)

        // 位置索引首次生成完要落盘,下次开书省去重算。engine 在生成完成时和每次翻页时
        // 都会触发 onRelocated,这里复用同一个回调:exportLocations() 在索引还没
        // 就绪时返回 null,一旦第一次拿到非 null 值就存一次,之后不再重复写。
        // 必须在 open() 之前完成订阅:locations.generate() 是 open() 内部发起的,
        // 小书可能在 open()/display() 都还没返回的时候就生成完毕并触发一次 onRelocated,
        // 注册晚了就会错过这次通知,索引要等到下一次真正翻页才会落盘。engine.destroy()/
        // 重新 open() 都不会清空 onRelocated 的订阅列表(teardown() 特意保留它),
        // 所以提前订阅是安全的。
        let locationsSaved = savedLocations !== null
        let relocation = 0
        unsubscribeRelocated = engine.onRelocated(() => {
          const request = ++relocation
          const completedRestore = restoreGate.consumeRelocation()
          if (completedRestore) setRestoring(false)
          const cfi = completedRestore ? book.lastReadCfi : anchorCfiRef.current ?? engine!.currentCfi()
          const canSave = !restoreGate.restoring
          void engine!.getVisible().then((v) => {
            if (cancelled || request !== relocation) return
            handleVisible(v)
            if (cfi && canSave && v.totalPages > 0) {
              void window.api.saveProgress(book.id, cfi, v.readProgress).then(() => {
                if (!cancelled) setError((old) => old === '阅读位置保存失败，请翻页后重试' ? null : old)
              }).catch(() => {
                if (!cancelled) setError('阅读位置保存失败，请翻页后重试')
              })
            }
          }).catch((error: unknown) => {
            // 书还没有打开时 getVisible() 会抛错。display() 运行前回调就可能被触发，
            // 此时没有任何内容可见，静默处理这个失败即可——如果书其实读不出来，
            // 下面的 stuckTimer 兜底会在几秒后把这个情况变成界面上的错误提示。
            if (!cancelled && engine!.currentCfi()) setError(error instanceof Error ? error.message : String(error))
          })
          if (!locationsSaved) {
            const json = engine!.exportLocations()
            if (json) {
              locationsSaved = true
              // 位置索引写入失败同样静默:损失的只是下次开书时重新计算索引的时间,
              // 不影响当前阅读,但仍要接住 rejection,不能变成未处理的 promise 拒绝。
              void window.api.saveLocations(book.id, json).catch(() => { locationsSaved = false })
            }
          }
        })

        // 按键翻页与快捷键统一走 engine.onKey:它同时接住外层 window 和书内容
        // iframe 里的 keydown(EPUB 经 epub.js 转发,PDF 在各页 iframe 里直挂),
        // 所以同一套映射在两种版式下都生效;输入框内按键由引擎侧直接过滤,不进这里。
        unsubscribeKey = engine.onKey((key) => {
          if (key === 'Find') setSearchOpen(true)
          else if (key === 'ArrowRight' || key === 'PageDown') next()
          else if (key === 'ArrowLeft' || key === 'PageUp') prev()
          else if (key === 'Escape') {
            toolRef.current = 'select'
            setReadingToolState('select')
            engine?.setReadingTool('select')
            // Esc 顺手收起小面板:只关,不报错,不吞翻页。
            setShowTypography(false)
            setShortcutsOpen(false)
          }
          else if (key === '?') setShortcutsOpen(true)
          else if (key.toLowerCase() === shortcutTocRef.current) setShowToc((v) => !v)
          else if (key.toLowerCase() === shortcutBookmarkRef.current) void toggleBookmarkRef.current()
        })

        await engine.open(data, {
          fontSize: Number.isFinite(savedFont) ? savedFont : 18,
          theme: themeRef.current,
          savedLocations,
          // PDF 引擎忽略该字段(固定版式不受影响),EPUB 首屏即按预设排。
          typography: isPdf ? undefined : savedTypo,
          pdfView: savedPdfView,
          pdfPosition: savedPdfPosition ?? undefined,
          getPdfOcr: isPdf ? (page) => window.api.getPdfOcr(book.id, page) : undefined,
          onPdfViewChange: isPdf ? (settings) => {
            if (cancelled) return
            void window.api.setSetting('pdfView', JSON.stringify(settings)).catch(() => {
              if (!cancelled) setError('PDF 显示设置没有保存，请重试')
            })
          } : undefined,
          onPdfPositionChange: isPdf ? (position) => {
            if (cancelled || restoreGate.restoring) return
            void window.api.savePdfPosition(book.id, position).catch(() => {
              if (!cancelled) setError('PDF 阅读位置没有保存，请重试')
            })
          } : undefined
        })
        if (cancelled) return
        // 打开期间也可能切主题；发布引擎后由上面的 effect 应用最新主题。
        engine.setTheme(themeRef.current)
        setReaderEngine(engine)

        // 打开成功之后,如果 VISIBLE_STUCK_TIMEOUT_MS 之内一直等不到一次成功的
        // getVisible(),说明这本书是真的读不出来——跟下面 display() 刚返回时
        // 那种正常的排版空档不是一回事(那种情况几十毫秒内就会被 onRelocated
        // 补上)。这里用一个兜底计时器把这种真正的失败反映到界面上,而不是让
        // 阅读界面一直空白,连页码和错误提示都没有。一旦 handleVisible() 被
        // 调用过一次(不管是下面这次直接调用还是 onRelocated 里的那次),
        // 计时器会被清掉,不会误报。
        stuckTimer = setTimeout(() => {
          if (!cancelled && !hasVisible) {
            setError('书本内容长时间无法显示,可能是文件已损坏')
          }
        }, VISIBLE_STUCK_TIMEOUT_MS)

        setToc(engine.toc())
        try {
          await engine.display(book.lastReadCfi ?? undefined)
          if (cancelled) return

          // 恢复上次读到的位置时,这次 display() 有时会落在比保存的位置更靠前的地方
          // (亲测偏差正好是几个物理翻页)。原因是 epub.js 把 CFI 换算成滚动偏移量靠的
          // 是 manager.moveTo() 里的 view.locationOf()/this.layout.delta(见
          // node_modules/epubjs/src/managers/default/index.js 的 display()/moveTo()),
          // 这次调用发生在这本书在这个全新窗口里第一次真正跑完排版之前,量出来的列宽
          // /偏移还没定型,算出的滚动位置自然是错的。这个时机窗口有多长跟机器快慢有关,
          // 不能靠"反正再调一次 display() 时机就够晚了"这种运气——机器足够快或足够慢,
          // 两次调用都可能落进同一个还没定型的窗口。这里改成校验而不是假设:display()
          // 之后用 currentCfi() 回读引擎实际落到了哪里,跟目标位置比对,不一致就等一帧
          // (给排版一点时间定型)再重新 display() 一次,最多重试 MAX_POSITION_VERIFY_ATTEMPTS
          // 次;还是不一致就安静放弃,不能无限重试卡住阅读。首次打开新书(没有
          // lastReadCfi)不存在这个问题,不需要这段校验。
          if (book.lastReadCfi) {
            const target = book.lastReadCfi
            for (
              let attempt = 0;
              attempt < MAX_POSITION_VERIFY_ATTEMPTS && engine.currentCfi() !== target;
              attempt++
            ) {
              await waitForFrame()
              if (cancelled) return
              await engine.display(target)
              if (cancelled) return
            }
          }
        } finally {
          // display() resolve 早于 epub.js 的最终 relocated。这里仅结束本地位置恢复
          // 阶段并标记等待通知;UI 的 restoring 要由下一次 onRelocated 清掉。
          restoreGate.finishDisplay()
        }

        // open()/display() 期间位置索引可能已经在 onRelocated 订阅注册之后、
        // display() 返回之前的某次 relocated 通知里生成完成并存过了;但也可能那次
        // 通知发生在其他时序下没被接住,这里主动查一次兜底。locationsSaved 已经为
        // true 时 exportLocations() 的结果会被直接丢弃,不会重复写入。
        if (!locationsSaved) {
          const json = engine.exportLocations()
          if (json) {
            locationsSaved = true
            void window.api.saveLocations(book.id, json).catch(() => { locationsSaved = false })
          }
        }

        // epub.js 的 Rendition._display() 会在 manager.render() 完成、也就是我们的
        // display() 这个 await 返回的那一刻就 resolve,但它自己紧接着触发的
        // reportLocation() 是另外排进内部队列、靠 requestAnimationFrame 驱动的异步步骤
        // (见 node_modules/epubjs/src/rendition.js reportLocation()),要再等一帧才会
        // 真正把 rendition.location 填上。也就是说 display() 刚返回的这一刻,
        // rendition.location 几乎总是还是 undefined,这里立刻调用 getVisible() 十有
        // 八九会撞上这个空档而抛"书还没打开"。跟上面 onRelocated 回调里的同一个
        // getVisible() 调用一样处理:失败就静默跳过,不当作书打不开的致命错误——
        // 上面的 onRelocated 订阅马上会等到这次 display() 真正触发的 relocated 事件,
        // 到时候会用同一个 getVisible() 正常拿到结果并 setVisible()。
        // 如果在这里把这次失败当成致命错误(之前的写法),会把还没出错的阅读界面
        // 整页替换成"书还没打开"的错误提示,而且后面 visible 一旦被 onRelocated
        // 补上,这个 error 状态也不会被清掉,footer 里会一直挂着这条误报。
        try {
          const v = await engine.getVisible()
          handleVisible(v)
        } catch {
          // 见上面注释:这是 display() 刚返回、relocated 事件还没来得及触发的
          // 正常空档,不是书打不开——如果确实打不开,上面的 stuckTimer 兜底
          // 会在超时后把它变成界面上的错误提示,这里不需要再处理一次。
        }
      } catch (e) {
        clearStuckTimer()
        restoreGate.cancel()
        if (!cancelled) {
          setRestoring(false)
          setError(e instanceof Error ? e.message : '这本书打不开')
        }
      }
    }

    void boot()
    return () => {
      const position = engine?.getPdfPosition?.()
      if (position && !restoreGate.restoring) void window.api.savePdfPosition(book.id, position).catch(() => {})
      cancelled = true
      // 高亮读写按代际失效:切书/卸载后回来的读取与保存一律丢弃,不写进新书。
      hlGenRef.current++
      clearStuckTimer()
      fontChainRef.current = Promise.resolve()
      anchorCfiRef.current = null
      unsubscribeRelocated?.()
      unsubscribeKey?.()
      // 先退掉划选 store 再销毁引擎:store 自己会把页面上剩下的高亮抹掉,
      // 放到 destroy() 之后就成了对着已经销毁的 rendition 做事。
      selectionStore?.dispose()
      setSelectionStore(null)
      setReaderEngine(null)
      spreadRef.current = false
      setSpread(false)
      delete (window as unknown as SelectionTestHooks).__E2E_QUOTES__
      engine?.destroy()
      engineRef.current = null
      bookDataRef.current = null
    }
  }, [book, format, isPdf, next, prev])

  // 按键翻页现在完全由 engine.onKey 驱动(见上面 boot effect 里的订阅):它同时接住
  // 外层 window 和书内容 iframe 文档里的 keydown,这里不再需要自己挂 window 监听器。

  const changeFont = useCallback((delta: number) => {
    setFontSize((old) => {
      const size = Math.min(FONT_MAX, Math.max(FONT_MIN, old + delta))
      targetFontRef.current = size

      // 锁定锚点 CFI: 若当前尚未锁定,从当前稳定的阅读位置锁定,
      // 避免连续快速点击时因为排版临时滚动到 0 而把阅读位置重置回本章第 1 页。
      if (!layoutAnchorCfiRef.current) layoutAnchorCfiRef.current = engineRef.current?.currentCfi() ?? null
      if (!anchorCfiRef.current) anchorCfiRef.current = layoutAnchorCfiRef.current

      // 将最新字号应用排进串行队列,合流连续点击,避免并发渲染与死锁
      fontChainRef.current = fontChainRef.current.then(async () => {
        const engine = engineRef.current
        if (!engine) return
        if (targetFontRef.current === appliedFontRef.current) return
        const target = targetFontRef.current
        const anchor = layoutAnchorCfiRef.current
        try {
          await engine.setFontSize(target, anchor ?? undefined)
          appliedFontRef.current = target
        } catch {
          setError('字号调整失败，请重试')
        } finally {
          // 最后一次重排失败也必须释放锁，不能让之后翻页一直保存旧位置。
          if (targetFontRef.current === target) {
            anchorCfiRef.current = null
          }
        }
      })

      // 乐观更新了字号状态,写盘失败要在页脚提示,否则界面和存储的值会不一致却毫无提示。
      setError(null)
      if (!isPdf) window.api.setSetting('fontSize', String(size)).catch(() => {
        setError('字号没有保存,下次打开可能会恢复默认')
      })
      return size
    })
  }, [isPdf])

  const applyPdfView = (settings: Partial<PdfViewSettings>): void => {
    const engine = engineRef.current
    if (!engine?.setPdfView) return
    const target = normalizePdfView({ ...(pdfTargetRef.current ?? engine.getPdfView?.() ?? pdfView), ...settings })
    pdfTargetRef.current = target
    setError(null)
    fontChainRef.current = fontChainRef.current.then(async () => {
      if (engineRef.current !== engine) return
      await engine.setPdfView!(target)
      if (engineRef.current !== engine) return
      await window.api.setSetting('pdfView', JSON.stringify(target))
    }).catch(() => {
      if (engineRef.current === engine) setError('PDF 显示设置调整或保存失败，请重试')
    }).finally(() => { if (pdfTargetRef.current === target) pdfTargetRef.current = null })
  }

  const changePdfScale = (delta: number): void => {
    applyPdfView({ mode: 'custom', scale: (pdfTargetRef.current?.scale ?? engineRef.current?.getPdfView?.().scale ?? pdfView.scale) + delta })
  }

  const removeBookmark = useCallback(async (id: string) => {
    if (bookmarkDeletingRef.current) return
    bookmarkDeletingRef.current = true
    setDeletingBookmarkId(id)
    setBookmarkError(null)
    try {
      await window.api.deleteBookmark(id)
      setBookmarks((items) => items.filter((item) => item.id !== id))
    } catch {
      setBookmarkError('书签删除失败，请稍后重试')
    } finally {
      bookmarkDeletingRef.current = false
      setDeletingBookmarkId(null)
    }
  }, [])

  const toggleBookmark = useCallback(async () => {
    if (!visible) return
    if (currentBookmark) { await removeBookmark(currentBookmark.id); return }
    if (bookmarkDeletingRef.current) return
    setBookmarkError(null)
    try {
      const created = await window.api.addBookmark({
        bookId: book.id,
        startCfi: visible.startCfi,
        chapterLabel: visible.chapterLabel,
        excerpt: visible.text.replace(/\s+/g, ' ').trim().slice(0, 80)
      })
      setBookmarks((items) => [...items, created])
    } catch {
      setBookmarkError('书签保存失败，请稍后重试')
    }
  }, [book.id, currentBookmark, removeBookmark, visible])

  // 快捷键回调走这个引用,永远拿到最新的 visible(见上面 eraseRef 同例)。
  toggleBookmarkRef.current = toggleBookmark

  /**
   * 排版预设切换(EPUB/TXT):与 changeFont 同一套并发与落盘策略——锚定当前 CFI、
   * 串行进 fontChainRef 队列避免并发重排死锁,display(anchor) 保证 CFI 位置与进度
   * 不变,高亮/注释由引擎按原 CFI 重画重定位。写盘失败只在页脚提示,不回滚界面。
   */
  const applyTypography = useCallback((patch: Partial<TypographyOptions>): void => {
    if (isPdf) return
    const next: TypographyOptions = { ...targetTypoRef.current, ...patch }
    targetTypoRef.current = next
    setTypographyState(next)

    if (!layoutAnchorCfiRef.current) layoutAnchorCfiRef.current = engineRef.current?.currentCfi() ?? null
    if (!anchorCfiRef.current) anchorCfiRef.current = layoutAnchorCfiRef.current

    fontChainRef.current = fontChainRef.current.then(async () => {
      const engine = engineRef.current
      if (!engine) return
      const target = targetTypoRef.current
      const applied = appliedTypoRef.current
      if (
        target.lineHeight === applied.lineHeight &&
        target.margin === applied.margin &&
        target.fontFamily === applied.fontFamily
      ) return
      const anchor = layoutAnchorCfiRef.current
      try {
        await engine.setTypography(target, anchor ?? undefined)
        appliedTypoRef.current = { ...target }
      } catch {
        setError('排版调整失败,请重试')
      } finally {
        // 最后一次重排之后没有更新的补丁,才释放锚点(见 changeFont 同例)。
        const latest = targetTypoRef.current
        if (
          latest.lineHeight === target.lineHeight &&
          latest.margin === target.margin &&
          latest.fontFamily === target.fontFamily
        ) {
          anchorCfiRef.current = null
        }
      }
    }).catch(() => {})

    setError(null)
    const saves: [string, string][] = []
    if (patch.lineHeight !== undefined) saves.push(['lineHeight', String(next.lineHeight)])
    if (patch.margin !== undefined) saves.push(['pageMargin', next.margin])
    if (patch.fontFamily !== undefined) saves.push(['fontFamily', next.fontFamily])
    for (const [key, value] of saves) {
      window.api.setSetting(key, value).catch(() => {
        setError('排版没有保存,下次打开可能会恢复默认')
      })
    }
  }, [isPdf])

  /**
   * 保存两项可配置快捷键:先校验(单字母数字、非保留键、互不相同),不过直接报错、
   * 不写盘不改映射;通过才更新引用与界面并落盘。
   */
  const saveShortcutMapping = useCallback((rawToc: string, rawBookmark: string): void => {
    const next = {
      toggleToc: rawToc.trim().toLowerCase(),
      toggleBookmark: rawBookmark.trim().toLowerCase()
    }
    const problem = validateShortcutMapping(next)
    if (problem) {
      setShortcutError(problem)
      return
    }
    setShortcutError(null)
    shortcutTocRef.current = next.toggleToc
    shortcutBookmarkRef.current = next.toggleBookmark
    setShortcutToc(next.toggleToc)
    setShortcutBookmark(next.toggleBookmark)
    window.api.setSetting('shortcutToc', next.toggleToc).catch(() => {
      setError('快捷键没有保存,下次打开可能会恢复默认')
    })
    window.api.setSetting('shortcutBookmark', next.toggleBookmark).catch(() => {
      setError('快捷键没有保存,下次打开可能会恢复默认')
    })
  }, [])

  const resetShortcuts = useCallback((): void => {
    setShortcutError(null)
    saveShortcutMapping(DEFAULT_SHORTCUTS.toggleToc, DEFAULT_SHORTCUTS.toggleBookmark)
  }, [saveShortcutMapping])

  const jump = useCallback((href: string) => {
    setShowToc(false)
    clearLayoutAnchor()
    engineRef.current?.display(href).catch(() => {
      setError('跳转失败,目标章节可能已被移动')
    })
  }, [clearLayoutAnchor])

  // 阅读工具三选一、互斥切换;点已选中的工具回到普通划选,Esc 同样回到普通划选。
  const setTool = useCallback((tool: ReadingTool): void => {
    if (tool !== 'select' && ocrRequestRef.current) ocrRequestRef.current.selection = undefined
    toolRef.current = tool
    setReadingToolState(tool)
    engineRef.current?.setReadingTool(tool)
  }, [])

  const cancelOcr = useCallback(() => {
    const job = ocrRequestRef.current
    ocrRequestRef.current = null
    if (job) {
      // Explicit cancellation also pauses hover preparation on this page until
      // another drag or a leave/return cycle; it must not instantly restart.
      ocrAttemptedRef.current.add(`${job.page}:${job.language}`)
      void window.api.cancelPdfOcr(job.id).catch(() => {})
    }
    setOcrBusy(false)
    setOcrProgress(null)
  }, [])

  const runOcr = useCallback((page: number, region?: PdfOcrRegion, retry = false) => {
    const engine = engineRef.current
    if (!engine?.capturePdfPage || toolRef.current !== 'select') return false
    if (!region && ocrError && !retry) return true
    if (region && engine.selectPdfRegion?.(page, region)) return true
    const active = ocrRequestRef.current
    if (active) {
      if (!region) return active.page === page && !active.region
      // Keep a running whole-page job; replay only the latest drag once its words arrive.
      if (active.page === page && !active.region) {
        active.selection = region; ocrRetryRef.current = { page, region }; return true
      }
      cancelOcr()
    }
    const attempt = `${page}:${ocrLanguage}`
    if (!region && ocrAttemptedRef.current.has(attempt)) return true
    if (!region) ocrAttemptedRef.current.add(attempt)
    const job = { id: crypto.randomUUID(), page, language: ocrLanguage, region, selection: region }
    ocrRequestRef.current = job
    ocrRetryRef.current = { page, region }
    setOcrBusy(true); setOcrError(null); setOcrProgress(null); setOcrSourcePage(page)
    const previous = ocrSettledRef.current
    // Cancellation terminates the worker asynchronously. Wait for the previous
    // request's cleanup before claiming the single OCR worker with a new request.
    const work = (async () => {
      const current = (): boolean => ocrRequestRef.current === job && engineRef.current === engine
      try {
        await previous
        if (!current()) return
        const capture = await engine.capturePdfPage!(region, page)
        if (!current()) return
        const result = await window.api.pdfOcr({ requestId: job.id, bookId: book.id, page: capture.page,
          image: capture.image, language: ocrLanguage, region: region ?? null })
        if (!current()) return
        const shown = await engine.getVisible()
        if (shown.page !== page && !shown.pdfScanPages?.includes(page)) return
        if (!result.text.trim() || !result.words.length) {
          setOcrError('没有识别到可定位的文字，请拖选更清晰的区域，或换一种语言重试。'); return
        }
        await engine.refreshPdfOcr?.()
        if (!current()) return
        if (job.selection && toolRef.current === 'select') {
          if (!region && engine.selectPdfRegion?.(page, job.selection)) return
          const source = region ? engine.pdfOcrQuote?.(result.id) : null
          if (source && selectionStore) {
            if (!selectionStore.list().some(quote => quote.cfiRange === source.cfiRange)) {
              selectionStore.toggle(source.cfiRange, result.text.trim(), source.startCfi)
            }
          } else setOcrError('选区内未找到文字，请重新拖选文字所在的区域。')
        }
      } catch (error) {
        if (current()) setOcrError(error instanceof Error ? error.message : '文字识别失败，请重试')
      } finally {
        if (current()) { ocrRequestRef.current = null; setOcrBusy(false); setOcrProgress(null) }
      }
    })()
    ocrSettledRef.current = work
    return true
  }, [book.id, ocrLanguage, ocrError, selectionStore, cancelOcr])

  useEffect(() => readerEngine?.onPdfRegion?.((page, region) => { void runOcr(page, region) }), [readerEngine, runOcr])
  useEffect(() => readerEngine?.onPdfOcrNeeded?.(page => runOcr(page)), [readerEngine, runOcr])
  useEffect(() => {
    if (!isPdf) return
    return window.api.onPdfOcrProgress((progress) => {
      if (progress.requestId === ocrRequestRef.current?.id) setOcrProgress(progress)
    })
  }, [isPdf])
  useEffect(() => {
    ocrAttemptedRef.current.clear(); ocrRetryRef.current = null; setOcrError(null)
    return () => {
      const job = ocrRequestRef.current
      ocrRequestRef.current = null
      if (job) void window.api.cancelPdfOcr(job.id).catch(() => {})
    }
  }, [book.id])
  useEffect(() => {
    const job = ocrRequestRef.current
    if (job && visible && job.page !== visible.page && !visible.pdfScanPages?.includes(job.page)) cancelOcr()
    if (visible) {
      const shownPages = [visible.page, ...(visible.pdfScanPages ?? [])]
      for (const key of ocrAttemptedRef.current) {
        if (!shownPages.includes(Number(key.split(':')[0]))) ocrAttemptedRef.current.delete(key)
      }
    }
    setOcrError(null)
  }, [visible?.page, visible?.pdfScanPages?.join(','), cancelOcr])
  useEffect(() => {
    const cancel = (event: KeyboardEvent): void => { if (event.key === 'Escape') cancelOcr() }
    window.addEventListener('keydown', cancel)
    const off = readerEngine?.onKey(key => { if (key === 'Escape') cancelOcr() })
    return () => { window.removeEventListener('keydown', cancel); off?.() }
  }, [readerEngine, cancelOcr])

  useEffect(() => {
    if (scanPage && (toolRef.current === 'highlight' || toolRef.current === 'erase')) setTool('select')
  }, [scanPage, setTool])

  useEffect(() => {
    if (!readerEngine || readingTool !== 'highlight') return
    return readerEngine.onSelected((cfiRange, text, _point, startCfi) => {
      if (toolRef.current !== 'highlight' || highlightsRef.current.some((item) => item.cfiRange === cfiRange)) return
      const gen = hlGenRef.current
      void window.api.addHighlight({ bookId: book.id, cfiRange, startCfi, quote: text.trim().slice(0, 200000) })
        .then((saved) => {
          if (gen !== hlGenRef.current || highlightsRef.current.some((item) => item.cfiRange === saved.cfiRange)) return
          highlightsRef.current = [...highlightsRef.current, saved]
          setHighlights([...highlightsRef.current])
          setHighlightError(null)
        }).catch(() => {
          if (gen === hlGenRef.current) setHighlightError('荧光笔保存失败，请重新划选')
        })
    })
  }, [readerEngine, readingTool, book.id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof Element && e.target.closest('input,textarea,[contenteditable]')) return
      if (e.key === 'Escape') {
        setTool('select')
        setShowTypography(false)
        setShortcutsOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setTool])

  // 持久高亮被点:只有橡皮模式下才擦除整块,其它模式点它什么也不做。
  // 擦除只删持久表这一条,注释与临时引用碰都不碰;删盘失败不清列表、不假装成功。
  const eraseHighlight = useCallback(async (id: string): Promise<void> => {
    if (toolRef.current !== 'erase') return
    const target = highlightsRef.current.find((h) => h.id === id)
    if (!target) return
    const gen = hlGenRef.current
    try {
      await window.api.deleteHighlight(id)
      if (gen !== hlGenRef.current) return
      highlightsRef.current = highlightsRef.current.filter((h) => h.id !== id)
      setHighlights([...highlightsRef.current])
      lastErasedRef.current = target
      setLastErased(target)
      setHighlightError(null)
    } catch {
      if (gen !== hlGenRef.current) return
      setHighlightError('擦除失败，请稍后重试')
    }
  }, [])

  // 引擎回调要一个引用稳定的函数,里面永远走最新的 eraseHighlight。
  const eraseRef = useRef((id: string): void => { void eraseHighlight(id) })
  eraseRef.current = (id: string): void => { void eraseHighlight(id) }

  // 存盘列表是真相,引擎只负责画:列表或引擎任一变化就整表推过去。
  useEffect(() => {
    if (!readerEngine) return
    readerEngine.setReadingTool(toolRef.current)
    readerEngine.setPersistentHighlights(
      highlights.map((h) => ({ id: h.id, cfiRange: h.cfiRange })),
      (id) => eraseRef.current(id)
    )
  }, [readerEngine, highlights])

  // 撤销上一次擦除:按原 CFI 范围重新存一条(持久恢复),已存在同样范围时不复制。
  const undoErase = useCallback(async (): Promise<void> => {
    const target = lastErasedRef.current
    if (!target) return
    if (highlightsRef.current.some((h) => h.cfiRange === target.cfiRange)) {
      lastErasedRef.current = null
      setLastErased(null)
      return
    }
    const gen = hlGenRef.current
    try {
      const restored = await window.api.addHighlight({
        bookId: book.id, cfiRange: target.cfiRange, startCfi: target.startCfi, quote: target.quote
      })
      if (gen !== hlGenRef.current) return
      if (lastErasedRef.current?.id === target.id) {
        lastErasedRef.current = null
        setLastErased(null)
      }
      highlightsRef.current = [...highlightsRef.current.filter((item) => item.cfiRange !== restored.cfiRange), restored]
      setHighlights([...highlightsRef.current])
      setHighlightError(null)
    } catch {
      if (gen === hlGenRef.current) setHighlightError('撤销失败，请稍后重试')
    }
  }, [book.id])

  // error 同时承载两类情况:书打不开(致命,此时 visible 还没被设置过,整页替换成
  // 错误提示)和设置写盘失败(非致命,阅读已经在正常进行,只在页脚提一句,不打断阅读)。
  // error && !visible 的判断依赖:当用户返回书架时,此组件会完全卸载，下一次打开书
  // 时是一个全新的实例,visible 总是从未设置状态开始。如果组件被复用于不同的书，这个
  // 假设就会被破坏，导致设置错误误显示为整页错误。
  if (error && !visible) {
    return (
      <div className="reader__error">
        <p>{error}</p>
        <button onClick={onBack}>← 回到书架</button>
      </div>
    )
  }

  return (
    <div className="reader">
      <header className="reader__bar">
        <button className="button--ghost" disabled={annotationState.saving} onClick={() => {
          if (annotationState.dirty) setConfirmLeave(true)
          else onBack()
        }}>← 书架</button>
        <button className="button--ghost" onClick={() => setShowToc((v) => !v)} data-testid="toggle-toc" title={`目录 (${shortcutToc})`}>
          目录
        </button>
        <button
          ref={searchToggleRef}
          className="button--ghost"
          type="button"
          data-testid="toggle-search"
          aria-expanded={searchOpen}
          disabled={!readerEngine}
          title="书内搜索 (Ctrl/Cmd+F)"
          onClick={() => { if (searchOpen) closeSearch(); else openSearch() }}
        >
          搜索
        </button>
        {!isPdf && (
          <button
            className="button--ghost"
            type="button"
            data-testid="toggle-typography"
            aria-expanded={showTypography}
            title="排版预设:行距 / 页边距 / 字体"
            disabled={!readerEngine}
            onClick={() => setShowTypography((v) => !v)}
          >
            排版
          </button>
        )}
        <button
          className="button--ghost"
          type="button"
          data-testid="toggle-shortcuts"
          title="键盘快捷键 (?)"
          onClick={() => { setShortcutError(null); setShortcutsOpen(true) }}
        >
          快捷键
        </button>
        <button
          className={`button--ghost reader__bookmark${currentBookmark ? ' reader__bookmark--active' : ''}`}
          type="button"
          data-testid="bookmark-toggle"
          aria-pressed={Boolean(currentBookmark)}
          disabled={!visible || !!deletingBookmarkId}
          title={`书签 (${shortcutBookmark})`}
          onClick={() => void toggleBookmark()}
        >
          {currentBookmark ? '★ 已加书签' : '☆ 书签'}
        </button>
        <button
          className={`button--ghost${readingTool === 'highlight' ? ' reader__tool--active' : ''}`}
          type="button"
          data-testid="tool-highlight"
          disabled={!readerEngine || !highlightsReady || scanPage}
          title={scanPage ? '此页没有文字层，暂不能按句子高亮' : '选中句子添加高亮'}
          aria-pressed={readingTool === 'highlight'}
          onClick={() => setTool(readingTool === 'highlight' ? 'select' : 'highlight')}
        >
          荧光笔
        </button>
        <button
          className={`button--ghost${readingTool === 'erase' ? ' reader__tool--active' : ''}`}
          type="button"
          data-testid="tool-erase"
          disabled={!readerEngine || !highlightsReady || scanPage}
          aria-pressed={readingTool === 'erase'}
          onClick={() => setTool(readingTool === 'erase' ? 'select' : 'erase')}
        >
          橡皮
        </button>
        {lastErased && (
          <button
            className="button--ghost"
            type="button"
            data-testid="highlight-undo"
            onClick={() => void undoErase()}
          >
            撤销擦除
          </button>
        )}
        <div className="reader__translation-group" role="group" aria-label="AI 翻译">
          <button
            className={`button--ghost${translationEnabled ? ' reader__translation-toggle--active' : ''}`}
            type="button"
            data-testid="translation-enable"
            aria-pressed={translationEnabled}
            disabled={translationToggling}
            title={translationEnabled ? '关闭本书 AI 翻译（与书架开关同步，缓存保留）' : '开启本书 AI 翻译（与书架开关同步）'}
            onClick={() => void toggleTranslationEnabled()}
          >
            {translationEnabled ? '译·开' : '译·关'}
          </button>
          {translationEnabled && !translationStarted && (
            <button
              className="button--ghost"
              type="button"
              data-testid="translation-start"
              disabled={!visible || translation.busy}
              title="开始 AI 翻译：按内容分句缓存，只译未译过的分句，不会一次性全书翻译"
              onClick={() => {
                setTranslationStarted(true)
                // 首次点击即切到译文：有缓存秒显，无缓存显示“正在翻译”。
                setTranslationView('translated')
              }}
            >
              {translation.busy ? '翻译中…' : '翻译'}
            </button>
          )}
          {translationEnabled && translationStarted && (
            <button
              className={`button--ghost${translationView === 'translated' ? ' reader__translation-toggle--active' : ''}`}
              type="button"
              data-testid="translation-toggle"
              aria-pressed={translationView === 'translated'}
              disabled={!visible}
              title="切换原文 / 译文"
              onClick={() => setTranslationView((v) => (v === 'translated' ? 'original' : 'translated'))}
            >
              {translationView === 'translated' ? '译文' : '原文'}
            </button>
          )}
        </div>
        <span className="reader__title">{book.title}</span>
        <span className="reader__spacer" />
        <ReadAloud key={book.id} visible={visible} onNext={next} engine={readerEngine}
          unavailableReason={scanPage ? '此页没有文字层，识别文字后才能朗读' : undefined}
          onPickPosition={() => setTool('select')} />
        <div className="reader__controls" aria-label="阅读设置">
        {!isPdf && <>
        <button className="button--icon" onClick={() => changeFont(-2)} aria-label="缩小字号">
          A−
        </button>
        <span className="reader__fontsize" data-testid="font-size">
          {fontSize}
        </span>
        <button className="button--icon" onClick={() => changeFont(2)} aria-label="放大字号">
          A+
        </button>
        </>}
        <button type="button" className="button--ghost" data-testid="toggle-theme" onClick={onToggleTheme}>{theme === 'light' ? '夜间模式' : '日间模式'}</button>
        </div>
      </header>

      {isPdf && <div className="reader__pdf-tools" data-testid="pdf-view-controls" role="group" aria-label="PDF 原版阅读设置">
        <span className="reader__pdf-label">PDF · 原版阅读</span>
        <div className="reader__pdf-fit">
          <button type="button" className="button--ghost" disabled={!visible} aria-pressed={pdfView.mode === 'page'}
            onClick={() => applyPdfView({ mode: 'page', scale: pdfScale })}>适合整页</button>
          <button type="button" className="button--ghost" disabled={!visible} aria-pressed={pdfView.mode === 'width'}
            onClick={() => applyPdfView({ mode: 'width', scale: pdfScale })}>适合宽度</button>
        </div>
        <div className="reader__pdf-zoom">
          <button type="button" className="button--icon" aria-label="缩小 PDF" disabled={!visible || pdfScale <= 0.25}
            onClick={() => changePdfScale(-0.25)}>−</button>
          <select aria-label="PDF 缩放比例" data-testid="pdf-scale" disabled={!visible} value={String(pdfScale)}
            onChange={(event) => applyPdfView({ mode: 'custom', scale: Number(event.target.value) })}>
            {Array.from(new Set([...PDF_SCALES, pdfScale])).sort((a, b) => a - b).map((scale) =>
              <option value={String(scale)} key={scale}>{Math.round(scale * 100)}%</option>)}
          </select>
          <button type="button" className="button--icon" aria-label="放大 PDF" disabled={!visible || pdfScale >= 4}
            onClick={() => changePdfScale(0.25)}>＋</button>
        </div>
        <button type="button" className={`button--ghost${readingTool === 'pan' ? ' reader__tool--active' : ''}`}
          data-testid="tool-pan" disabled={!visible} aria-pressed={readingTool === 'pan'}
          onClick={() => setTool(readingTool === 'pan' ? 'select' : 'pan')}>拖动页面</button>
        <label className="reader__pdf-contrast">对比度 <select aria-label="PDF 对比度" data-testid="pdf-contrast"
          value={String(pdfView.contrast ?? 1)} disabled={!visible}
          onChange={(event) => applyPdfView({ contrast: Number(event.target.value) })}>
          <option value="1">原图</option><option value="1.25">增强</option><option value="1.5">较强</option><option value="2">强</option>
        </select></label>
        <div className="reader__pdf-ocr-tools">
          <select aria-label="文字识别语言" value={ocrLanguage} disabled={ocrBusy}
            onChange={(event) => setOcrLanguage(event.target.value as PdfOcrLanguage)}>
            <option value="chi_sim+eng">中文 + 英文</option><option value="eng">英文</option>
          </select>
        </div>
        <span className="reader__pdf-hint">{readingTool === 'pan' ? '拖动查看 · Esc 返回选择' : '直接拖选文字 · Ctrl/⌘ + 滚轮缩放'}</span>
      </div>}

      {searchOpen && (
        <div className="reader__search" role="search" aria-label="书内搜索">
          <form
            className="reader__search-bar"
            onSubmit={(event) => {
              event.preventDefault()
              // 回车直接跳到当前高亮的命中,列表为空时什么也不做。
              if (!searchBusy && searchResults.length > 0) goToSearchResult(searchIndex)
            }}
          >
            <input
              ref={searchInputRef}
              data-testid="inbook-search-input"
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation()
                  closeSearch()
                }
              }}
              placeholder="在本书内搜索…"
              aria-label="在本书内搜索"
              autoComplete="off"
            />
            <span data-testid="inbook-search-count" aria-live="polite">
              {searchBusy
                ? '正在搜索…'
                : searchTouched
                  ? searchResults.length === 0
                    ? (searchQuery.trim() ? '无结果' : '')
                    : `${searchIndex + 1} / ${searchResults.length}`
                  : isPdf ? '支持文本层 PDF' : ''}
            </span>
            <button
              type="button"
              className="button--ghost"
              data-testid="inbook-search-prev"
              disabled={searchResults.length === 0}
              aria-label="上一个搜索结果"
              onClick={() => stepSearch(-1)}
            >
              ↑
            </button>
            <button
              type="button"
              className="button--ghost"
              data-testid="inbook-search-next"
              disabled={searchResults.length === 0}
              aria-label="下一个搜索结果"
              onClick={() => stepSearch(1)}
            >
              ↓
            </button>
            <button
              type="button"
              className="button--ghost"
              data-testid="inbook-search-close"
              aria-label="关闭书内搜索"
              onClick={closeSearch}
            >
              ✕
            </button>
          </form>
          {searchError && (
            <div className="reader__search-error" role="alert" data-testid="inbook-search-error">
              {searchError}
            </div>
          )}
          {searchTouched && !searchBusy && !searchError && searchQuery.trim() && searchResults.length === 0 && (
            <div className="reader__search-empty">本书内没有找到“{searchQuery.trim().slice(0, 60)}”</div>
          )}
          {searchResults.length > 0 && (
            <ul className="reader__search-list">
              {searchResults.map((hit, idx) => (
                <li key={`${hit.cfiRange}#${idx}`}>
                  <button
                    type="button"
                    data-testid="inbook-search-result"
                    data-active={idx === searchIndex || undefined}
                    className={`reader__search-item${idx === searchIndex ? ' reader__search-item--active' : ''}`}
                    aria-current={idx === searchIndex ? 'true' : undefined}
                    onClick={() => goToSearchResult(idx)}
                  >
                    <span className="reader__search-label">{hit.label}</span>
                    <span className="reader__search-excerpt">{hit.excerpt || '(无摘要)'}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {showTypography && !isPdf && (
        <div className="reader__typo" role="group" aria-label="排版预设" data-testid="typography-panel">
          <div className="reader__typo-row">
            <span id="typo-lineheight-label">行距</span>
            <div role="radiogroup" aria-labelledby="typo-lineheight-label">
              {LINE_HEIGHT_PRESETS.map((preset) => {
                const label = preset === 1.5 ? '紧凑' : preset === 1.75 ? '标准' : '疏朗'
                return (
                  <button
                    key={preset}
                    type="button"
                    className={`button--ghost${typography.lineHeight === preset ? ' reader__tool--active' : ''}`}
                    data-testid={`typo-lineheight-${preset}`}
                    aria-pressed={typography.lineHeight === preset}
                    title={`行距 ${preset}`}
                    onClick={() => applyTypography({ lineHeight: preset })}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          </div>
          <div className="reader__typo-row">
            <span id="typo-margin-label">页边距</span>
            <div role="radiogroup" aria-labelledby="typo-margin-label">
              {(['narrow', 'normal', 'wide'] as PageMarginName[]).map((name) => {
                const label = name === 'narrow' ? '窄' : name === 'normal' ? '标准' : '宽'
                return (
                  <button
                    key={name}
                    type="button"
                    className={`button--ghost${typography.margin === name ? ' reader__tool--active' : ''}`}
                    data-testid={`typo-margin-${name}`}
                    aria-pressed={typography.margin === name}
                    onClick={() => applyTypography({ margin: name })}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          </div>
          <div className="reader__typo-row">
            <span id="typo-font-label">字体</span>
            <div role="radiogroup" aria-labelledby="typo-font-label">
              {(['serif', 'sans'] as FontFamilyName[]).map((name) => (
                <button
                  key={name}
                  type="button"
                  className={`button--ghost${typography.fontFamily === name ? ' reader__tool--active' : ''}`}
                  data-testid={`typo-font-${name}`}
                  aria-pressed={typography.fontFamily === name}
                  onClick={() => applyTypography({ fontFamily: name })}
                >
                  {name === 'serif' ? '衬线' : '无衬线'}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {shortcutsOpen && (
        <div
          className="modal-overlay"
          data-testid="shortcuts-help"
          onClick={() => setShortcutsOpen(false)}
        >
          <div
            className="modal reader__shortcuts"
            role="dialog"
            aria-modal="true"
            aria-label="键盘快捷键"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation()
                setShortcutsOpen(false)
              }
            }}
          >
            <h2>键盘快捷键</h2>
            <p className="modal__copy">正文内外通用;在输入框里打字时单键快捷键不触发。</p>
            <dl className="reader__shortcut-list">
              <div><dt><kbd>→</kbd> / <kbd>PgDn</kbd></dt><dd>下一页</dd></div>
              <div><dt><kbd>←</kbd> / <kbd>PgUp</kbd></dt><dd>上一页</dd></div>
              <div><dt><kbd>Ctrl</kbd>+<kbd>F</kbd></dt><dd>书内搜索</dd></div>
              <div><dt><kbd>{shortcutToc}</kbd></dt><dd>打开 / 关闭目录</dd></div>
              <div><dt><kbd>{shortcutBookmark}</kbd></dt><dd>加入 / 取消书签</dd></div>
              <div><dt><kbd>Esc</kbd></dt><dd>回到普通划选并关闭面板</dd></div>
              <div><dt><kbd>?</kbd></dt><dd>打开本帮助</dd></div>
            </dl>
            <div className="reader__shortcut-config">
              <label>目录键 <input ref={shortcutTocInputRef} data-testid="shortcut-input-toc" defaultValue={shortcutToc} maxLength={1} aria-label="目录快捷键" autoComplete="off" /></label>
              <label>书签键 <input ref={shortcutBookmarkInputRef} data-testid="shortcut-input-bookmark" defaultValue={shortcutBookmark} maxLength={1} aria-label="书签快捷键" autoComplete="off" /></label>
              <button
                type="button"
                className="button--secondary"
                data-testid="shortcut-save"
                onClick={() => saveShortcutMapping(
                  shortcutTocInputRef.current?.value ?? shortcutToc,
                  shortcutBookmarkInputRef.current?.value ?? shortcutBookmark
                )}
              >
                保存
              </button>
              <button type="button" className="button--ghost" data-testid="shortcut-reset" onClick={resetShortcuts}>
                恢复默认
              </button>
            </div>
            {shortcutError && (
              <div className="reader__shortcut-error" role="alert" data-testid="shortcut-error">
                {shortcutError}
              </div>
            )}
            <div className="modal__actions">
              <button type="button" className="button--secondary" data-testid="shortcuts-close" onClick={() => setShortcutsOpen(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="reader__body">
        {showToc && (
          <TocPanel
            items={toc}
            currentHref={visible?.chapterHref ?? ''}
            bookmarks={bookmarks}
            deletingBookmarkId={deletingBookmarkId}
            onDeleteBookmark={(id) => void removeBookmark(id)}
            onJump={jump}
            onClose={() => setShowToc(false)}
          />
        )}
        <div className="reader__reading">
          <div className="reader__stage">
            {isPdf && (missingPdfText.length > 0 || ocrBusy || ocrError) && <div className="reader__ocr-status" data-testid="pdf-ocr-status" role="status">
              {ocrBusy ? <>
                <span>第 {ocrSourcePage} 页 · {ocrProgress?.status ?? '正在准备选字…'}<small>首次使用下载语言包；书页不上传</small></span>
                <progress max="1" value={ocrProgress?.progress ?? 0} aria-label="文字识别进度" />
                <button type="button" className="button--ghost" onClick={cancelOcr}>取消识别</button>
              </> : ocrError ? <>
                <span className="reader__ocr-error">{ocrError}</span>
                <button type="button" className="button--ghost" onClick={() => {
                  const retry = ocrRetryRef.current
                  if (!retry) return
                  ocrAttemptedRef.current.delete(`${retry.page}:${ocrLanguage}`); runOcr(retry.page, retry.region, true)
                }}>重试识别</button>
                <button type="button" className="button--ghost" aria-label="关闭识别提示" onClick={() => setOcrError(null)}>×</button>
              </> : <span data-testid="pdf-scan-notice">
                {missingPdfText.length === 1 && visible?.page === missingPdfText[0] ? '此页没有文字层' : `第 ${missingPdfText.join('、')} 页没有文字层`} · 直接拖选文字，自动识别
              </span>}
            </div>}
            <button className="reader__nav reader__nav--prev" onClick={prev} aria-label="上一页">
              ‹
            </button>
            <div className="reader__page" ref={hostRef} data-testid="reader-page" />
            {translationEnabled && translationView === 'translated' && (
              <div
                className="reader__translation reader__translation--overlay"
                data-testid="translation-view"
                role="region"
                aria-label="本页译文"
              >
                <p className="reader__translation-head">
                  {translation.current
                    ? `译文 · 第 ${visible?.page ?? '?'} 页`
                    : translation.busyKey
                      ? '正在翻译…'
                      : translation.error ?? '暂无本页译文'}
                </p>
                {translation.current && (
                  <p className="reader__translation-body">{translation.current.text}</p>
                )}
                {translation.current && (
                  <p className="reader__translation-foot">
                    {`已缓存 ${translation.segCount} 段 · 关闭后保留，下次直接显示`}
                  </p>
                )}
              </div>
            )}
            <button className="reader__nav reader__nav--next" onClick={next} aria-label="下一页">
              ›
            </button>
          </div>
          <footer className="reader__foot" data-testid="reader-foot">
            <span>{visible?.chapterLabel ?? ''}{scanPage ? ' · 扫描页面' : ''}</span>
            <span data-testid="page-indicator">
              {visible && visible.totalPages > 0
                ? `${isPdf ? '' : '约'}第 ${visible.page} / ${visible.totalPages} 页${!isPdf && visible.chapterPage && visible.chapterTotalPages ? ` · 本章 ${visible.chapterPage}/${visible.chapterTotalPages} 屏` : ''}`
                : '正在计算页码…'}
            </span>
            {isPdf && visible && <form className="reader__page-jump" onSubmit={(event) => {
              event.preventDefault()
              const input = event.currentTarget.elements.namedItem('page') as HTMLInputElement
              jump(`pdf-page-${input.value}`)
            }}>
              <label>跳页 <input key={visible.page} name="page" type="number" min="1" max={visible.totalPages}
                defaultValue={visible.page} required aria-label="PDF 跳转页码" /></label>
              <button type="submit" className="button--ghost">前往</button>
            </form>}
            {(error && visible) || bookmarkError || highlightError || statsError || translation.error ? (
              <span className="reader__foot-error" data-testid="settings-error">
                {error ?? bookmarkError ?? highlightError ?? statsError ?? translation.error}
              </span>
            ) : null}
          </footer>
        </div>
        <Sidebar
          book={book}
          engine={readerEngine}
          visible={visible}
          toc={toc}
          selection={selectionStore}
          restoring={restoring}
          spread={spread}
          onSetSpread={setSpreadMode}
          onNavigate={clearLayoutAnchor}
          onAnnotationState={updateAnnotationState}
        />
      </div>
      {confirmLeave && <ConfirmDialog title="注释还未提交" message="返回书架会丢弃当前注释草稿。可以取消返回，先提交保存。"
        confirmLabel="放弃并返回书架" onCancel={() => setConfirmLeave(false)} onConfirm={onBack}
        testId="confirm-note-leave" />}

    </div>
  )
}
