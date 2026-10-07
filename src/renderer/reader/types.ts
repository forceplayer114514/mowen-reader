import type { PdfOcrRegion, PdfOcrResult } from '../../shared/pdf-ocr-types'

export type ThemeName = 'light' | 'dark'

/** PDF keeps physical pages; scale is absolute, not an EPUB font-size multiplier. */
export interface PdfViewSettings {
  mode: 'page' | 'width' | 'custom'
  scale: number
  contrast?: number
}

export function normalizePdfView(raw: unknown): PdfViewSettings {
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw) } catch { raw = null }
  }
  const value = raw && typeof raw === 'object' ? raw as Partial<PdfViewSettings> : {}
  return {
    mode: value.mode === 'width' || value.mode === 'custom' ? value.mode : 'page',
    scale: typeof value.scale === 'number' && Number.isFinite(value.scale)
      ? Math.min(4, Math.max(0.25, value.scale)) : 1,
    contrast: typeof value.contrast === 'number' && Number.isFinite(value.contrast)
      ? Math.min(2, Math.max(1, value.contrast)) : 1
  }
}

/** Keep paper white while darkening faint ink, then apply the night palette. */
export function pdfImageFilter(theme: ThemeName, contrast = 1): string {
  const strength = normalizePdfView({ contrast }).contrast ?? 1
  const cssContrast = 2 * strength - 1
  // brightness before contrast maps x to strength*x + 1-strength.
  // Plain contrast() clips pale ink to white (or black after night inversion).
  return `brightness(${strength / cssContrast}) contrast(${cssContrast})${theme === 'dark' ? ' invert(.9) hue-rotate(180deg)' : ''}`
}

export interface TocItem {
  label: string
  href: string
  depth: number
}

export interface VisibleRange {
  /**
   * 正文纯文本。多数情况下是屏幕上实际可见的那一小段范围,取自 rangeCfi 圈定的
   * 精确区间;但当可见区域跨越两个章节文档、范围 CFI 无法合成时,会退化成当前
   * 渲染的整份章节文档全文(通常远超一屏可见内容)。这两种情况必须靠 approximate
   * 字段区分,不能只看这个字段本身——把退化情形误当成"屏幕上精确可见的文字"
   * 是没法用肉眼从数值上看出来的那类错误。
   */
  text: string
  startCfi: string
  endCfi: string
  /** 范围 CFI；EPUB 跨章无法合成时 approximate 为 true。PDF 并排两页也为空，但 text 是准确的两页全文。 */
  rangeCfi: string
  /**
   * text 是否只是近似值——true 时它是整份章节文档的全文,而不是屏幕上精确可见
   * 的那一小段;此时 rangeCfi 也会是空字符串。调用方(包括下一阶段拿 text 喂给
   * 模型的场景)在信任这段文本的精确边界之前,必须先检查这个字段。
   */
  approximate: boolean
  /** 当前所在章节的文件路径 */
  chapterHref: string
  /** 当前章节标题,目录里查不到时为 null */
  chapterLabel: string | null
  /** 当前排版下估算的全书页码，字号和阅读区域变化时重新计算 */
  page: number
  /** 当前排版下估算的全书总页数 */
  totalPages: number
  /** EPUB/TXT 当前章节实测屏数；全书估算页码可能在单屏翻动时不变。 */
  chapterPage?: number
  chapterTotalPages?: number
  /** 固定正文位置进度，不依赖排版页码；索引未就绪时为 0，真正末页才为 1。 */
  readProgress: number
  /** PDF only: active fit mode and actual rendered scale. */
  pdfView?: PdfViewSettings
  /** The visible scan uses a cached local OCR text layer, not native PDF text. */
  pdfOcr?: boolean
  /** Visible physical pages whose original PDF has no native text layer. */
  pdfScanPages?: number[]
  /** Visible physical pages still lacking usable native or cached OCR text. */
  pdfMissingTextPages?: number[]
}

/**
 * EPUB/TXT 排版预设:行距、页边距、字体三组,PDF 固定版式不受影响。
 * 存盘时按字符串存(见 db/settings.ts 白名单),读回时走 normalizeTypography() 校验,
 * 非法值一律退回默认值——不能让一条脏数据把正文排版打坏。
 */
export type FontFamilyName = 'serif' | 'sans'
export type PageMarginName = 'narrow' | 'normal' | 'wide'

export interface TypographyOptions {
  /** 行高倍数,预设三档 */
  lineHeight: number
  /** 页边距预设名 */
  margin: PageMarginName
  /** 衬线/无衬线两档 */
  fontFamily: FontFamilyName
}

export const DEFAULT_TYPOGRAPHY: TypographyOptions = {
  lineHeight: 1.75,
  margin: 'normal',
  fontFamily: 'serif'
}

/** 行距三档:紧凑 / 标准 / 疏朗 */
export const LINE_HEIGHT_PRESETS: readonly number[] = [1.5, 1.75, 2.0]

/** 页边距三档对应的正文左右内边距(px) */
export const PAGE_MARGIN_PX: Record<PageMarginName, number> = {
  narrow: 12,
  normal: 28,
  wide: 48
}

/** 两档字体的实际栈:阅读内容可用宋体,按钮等界面元素不受影响。 */
export const FONT_FAMILY_STACKS: Record<FontFamilyName, string> = {
  serif: `Georgia, 'Songti SC', 'STSong', 'Noto Serif CJK SC', serif`,
  sans: `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif`
}

export function normalizeLineHeight(raw: unknown): number {
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN
  if (!Number.isFinite(n)) return DEFAULT_TYPOGRAPHY.lineHeight
  let best = LINE_HEIGHT_PRESETS[0]
  for (const preset of LINE_HEIGHT_PRESETS) {
    if (Math.abs(preset - (n as number)) < Math.abs(best - (n as number))) best = preset
  }
  return best
}

export function normalizePageMargin(raw: unknown): PageMarginName {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (v === 'narrow' || v === 'normal' || v === 'wide') return v
  return DEFAULT_TYPOGRAPHY.margin
}

export function normalizeFontFamily(raw: unknown): FontFamilyName {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (v === 'serif' || v === 'sans') return v
  return DEFAULT_TYPOGRAPHY.fontFamily
}

export function normalizeTypography(raw: {
  lineHeight?: unknown
  margin?: unknown
  fontFamily?: unknown
}): TypographyOptions {
  return {
    lineHeight: normalizeLineHeight(raw.lineHeight),
    margin: normalizePageMargin(raw.margin),
    fontFamily: normalizeFontFamily(raw.fontFamily)
  }
}

/**
 * 快捷键可配置的两项:目录开关与书签开关(均为无修饰单键,不占 Ctrl/方向键/Esc)。
 * '?' 固定为帮助面板,不可配置;校验时拒绝保留键与重复映射。
 */
export const DEFAULT_SHORTCUTS = {
  toggleToc: 't',
  toggleBookmark: 'b'
} as const

export type ShortcutAction = keyof typeof DEFAULT_SHORTCUTS

/** 保留键:帮助面板与浏览器/阅读器已有绑定,不允许占用。 */
export const RESERVED_SHORTCUT_KEYS = ['?', '/', 'f'] as const

export function normalizeShortcutKey(raw: unknown, fallback: string): string {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (/^[a-z0-9]$/.test(v)) return v
  return fallback
}

/**
 * 校验用户输入的单键映射:单字母数字、非保留键、两项互不相同。
 * 返回 null 表示通过;否则返回给界面直接展示的错误文案。
 */
export function validateShortcutMapping(next: { toggleToc: string; toggleBookmark: string }): string | null {
  for (const [action, key] of Object.entries(next) as [ShortcutAction, string][]) {
    const v = key.trim().toLowerCase()
    // 保留键先报占用(文案更准),其它非法输入再报格式。
    if ((RESERVED_SHORTCUT_KEYS as readonly string[]).includes(v)) return `“${v}”已被系统占用,请换一个键`
    if (!/^[a-z0-9]$/.test(v)) return `${action === 'toggleToc' ? '目录' : '书签'}快捷键须为单个字母或数字`
  }
  if (next.toggleToc.trim().toLowerCase() === next.toggleBookmark.trim().toLowerCase()) {
    return '目录与书签不能使用同一个键'
  }
  return null
}

export interface OpenOptions {
  fontSize: number
  theme: ThemeName
  /** 上次存下的位置索引,有就直接用,免去重新计算 */
  savedLocations: string | null
  /** EPUB/TXT 首屏即按此排版;PDF 忽略 */
  typography?: TypographyOptions
  pdfView?: PdfViewSettings
  /** Cached OCR only: never starts recognition or a model download. */
  getPdfOcr?: (page: number) => Promise<PdfOcrResult[]>
  onPdfViewChange?: (settings: PdfViewSettings) => void
  pdfPosition?: { page: number; x: number; y: number } | null
  onPdfPositionChange?: (position: { page: number; x: number; y: number }) => void
}

export interface SelectionPoint {
  x: number
  y: number
}

export interface AnnotationMarker {
  id: string
  cfiRange: string
  number: number
}

/** 正文阅读工具:普通划选 / 荧光笔 / 橡皮,三者互斥。 */
export type ReadingTool = 'select' | 'highlight' | 'erase' | 'pan'

/** 持久高亮在引擎侧的最小形状:按 id 回调,整块擦除。 */
export interface PersistentHighlightItem {
  id: string
  cfiRange: string
}

/**
 * 书内全文搜索的一条命中。
 * EPUB(含 TXT 转 EPUB):cfiRange 是 section.search/find 给出的精确范围 CFI,
 * 直接 display() 即可落到命中位置;PDF(纯文本层):cfiRange 为 `pdf-page-N`,
 * display() 后翻到该页(扫描页无文本层则无命中)。
 */
export interface BookSearchResult {
  cfiRange: string
  /** 命中前后各一段上下文,已做空白归一化与截断,前后截断处带省略号。 */
  excerpt: string
  /** 章节标题;目录里查不到时为归一化后的 href,PDF 为目录标题或"第 N 页"。 */
  label: string
  /** 仅 PDF 有意义:命中的物理页码。 */
  page?: number
}

/** 书内搜索的上限:命中再多也只返回前这么多条,避免大书卡死界面。 */
export const MAX_SEARCH_RESULTS = 200

/**
 * 书内搜索的查询归一化:去前后空白并截断超长输入,空查询由调用方直接返回空数组。
 * 匹配本身大小写不敏感(epub.js 的 section.search/find 内部统一转小写比较,
 * PDF 侧同样转小写比较),这里不改大小写,只做长度与空白处理。
 */
export function normalizeSearchQuery(query: string): string {
  return query.trim().slice(0, 200)
}

/**
 * 把 epub.js 或 PDF 文本层给出的原始片段收敛成界面可直接展示的摘要:
 * 空白归一化、去首尾空格、超长截断(截断处补省略号)。
 * 不做高亮标记插入——摘要经 React 文本节点渲染,不会走到 innerHTML。
 */
export function cleanSearchExcerpt(raw: string, maxLen = 300): string {
  const text = raw.replace(/\s+/g, ' ').trim()
  if (text.length <= maxLen) return text
  return `${text.slice(0, maxLen).trimEnd()}…`
}

/** PDF 命中摘要前后各保留这么多字符的上下文。 */
export const PDF_SNIPPET_RADIUS = 60
/** PDF 单页最多贡献这么多条命中,避免某一页的重复词淹没整本书的结果。 */
export const PDF_MAX_PER_PAGE = 50

/** searchPdfPages 的输入:页码与该页已提取好的纯文本。 */
export interface PdfSearchPage {
  page: number
  text: string
}

/**
 * 取 PDF 命中位置的上下文摘要(保留原文大小写,只做空白归一化与截断)。
 * 截断处补省略号,调用方直接渲染为文本节点,不走 innerHTML。
 */
export function pdfExcerptForMatch(text: string, index: number, queryLength: number): string {
  const start = Math.max(0, index - PDF_SNIPPET_RADIUS)
  const end = Math.min(text.length, index + queryLength + PDF_SNIPPET_RADIUS)
  const snippet = text.slice(start, end).replace(/\s+/g, ' ').trim()
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return `${prefix}${snippet}${suffix}`
}

/**
 * 纯函数:在已提取好的页面文本上做大小写不敏感的全文查找。
 * PDF 引擎的 search() 负责逐页取文本层,这里只负责"给定文本找全部命中并拼摘要",
 * 方便单元测试覆盖匹配/摘要逻辑而不必启动 pdfjs。
 */
export function searchPdfPages(
  pages: PdfSearchPage[],
  query: string,
  labelForPage: (page: number) => string = (page) => `第 ${page} 页`,
  maxResults: number = MAX_SEARCH_RESULTS
): BookSearchResult[] {
  const q = normalizeSearchQuery(query)
  if (!q) return []
  const lowerQuery = q.toLowerCase()
  const results: BookSearchResult[] = []
  for (const { page, text } of pages) {
    if (results.length >= maxResults) break
    const lower = text.toLowerCase()
    let from = 0
    let perPage = 0
    for (;;) {
      const at = lower.indexOf(lowerQuery, from)
      if (at < 0) break
      results.push({
        // PDF 侧精确到页:display(`pdf-page-N`) 翻到该页(文本层缺失的扫描页无命中)。
        cfiRange: `pdf-page-${page}`,
        excerpt: pdfExcerptForMatch(text, at, q.length),
        label: labelForPage(page),
        page
      })
      perPage++
      if (results.length >= maxResults || perPage >= PDF_MAX_PER_PAGE) break
      from = at + Math.max(1, lowerQuery.length)
    }
  }
  return results
}

export interface ReaderEngine {
  open(data: ArrayBuffer, opts: OpenOptions): Promise<void>
  display(target?: string): Promise<void>
  next(): Promise<void>
  prev(): Promise<void>
  setSpread(on: boolean): Promise<void>
  setFontSize(px: number, anchorCfi?: string): void | Promise<void>
  /** Only fixed-layout PDF engines expose viewport controls. */
  setPdfView?(settings: PdfViewSettings): Promise<void>
  /**
   * 不翻页、不渲染，直接取指定物理页的文本（与 getVisible 同一提取公式，
   * 含已缓存的整页 OCR 回退）。供整书翻译后台预取下一页；无文本返回 null。
   */
  getPageText?(page: number): Promise<string | null>
  /** Includes pending wheel zoom, which may not have finished rendering yet. */
  getPdfView?(): PdfViewSettings
  capturePdfPage?(region?: PdfOcrRegion, page?: number): Promise<{ page: number; image: ArrayBuffer }>
  onPdfRegion?(cb: (page: number, region: PdfOcrRegion) => void): () => void
  onPdfOcrNeeded?(cb: (page: number) => boolean): () => void
  selectPdfRegion?(page: number, region: PdfOcrRegion): boolean
  refreshPdfOcr?(): Promise<void>
  pdfOcrQuote?(resultId: string): { cfiRange: string; startCfi: string } | null
  getPdfPosition?(): { page: number; x: number; y: number } | null
  /**
   * EPUB/TXT 排版预设:行距/页边距/字体。以锚点 CFI 重新落位,重排分页;
   * 高亮与注释按原 CFI 重画重定位,不改存盘位置之外的任何东西。
   * PDF 固定版式:实现为空操作。
   */
  setTypography(opts: TypographyOptions, anchorCfi?: string): void | Promise<void>
  setTheme(name: ThemeName): void
  getVisible(): Promise<VisibleRange>
  toc(): TocItem[]
  currentCfi(): string | null
  exportLocations(): string | null
  onRelocated(cb: () => void): () => void
  /** 订阅按键:同时接收外层 window 和书内容 iframe 文档里发生的 keydown。返回取消订阅函数。 */
  onKey(cb: (key: string) => void): () => void
  /**
   * 用户在书内容里完成一次拖选。返回取消订阅函数。
   *
   * 只有选中了非空白文字才会通知。**通知的时候浏览器自身的选区还在**,原生的蓝色
   * 选中块会短暂地压在订阅者随后加上的高亮上面,一轮通知全部走完才被收走——顺序
   * 只能是这样:这是鼠标事件的回调,没有任何调用栈接得住订阅者抛出来的异常,先收
   * 选区的话,一个订阅者炸了,后面的订阅者收不到通知、选区也没了,用户刚拖出来的
   * 那段话连复制都做不到。所以订阅者别假设选区已经空了。
   */
  onSelected(
    cb: (
      cfiRange: string,
      text: string,
      point: SelectionPoint | null,
      startCfi: string
    ) => void
  ): () => void
  /** 点选当前页正文后，返回从该位置到本页末尾的文字；仅在订阅期间生效。 */
  onReadPosition(cb: (text: string) => void): () => void
  /** 给一段范围加高亮;点击该高亮时调用 onClick。同一段范围重复加会先抹掉旧的那层。 */
  addHighlight(cfiRange: string, onClick: () => void): void
  /** 抹掉一段范围的高亮;这段范围本来就没高亮时什么也不做。 */
  removeHighlight(cfiRange: string): void
  /** 抹掉当前这本书上所有由本引擎加过的高亮。 */
  clearHighlights(): void
  /**
   * 持久荧光笔高亮:整表替换,存盘的 CFI 范围,不碰分页与正文 DOM。
   * 与上面的临时引用高亮各自记账、互不抹掉对方;点击某一块时按 id 回调,
   * 由调用方决定擦除整块。
   */
  setPersistentHighlights(items: PersistentHighlightItem[], onClick: (id: string) => void): void
  /** 切换阅读工具;引擎只在 erase 下不再把拖选当引用交出去,其它行为不变。 */
  setReadingTool(tool: ReadingTool): void
  /** 正文外的上标覆盖层，不插入 EPUB 文本、不改变 CFI 或分页。 */
  setAnnotations(items: AnnotationMarker[], onClick: (id: string) => void): void
  /**
   * 当前这本书内全文搜索(大小写不敏感,前后空白忽略,空查询返回空数组)。
   * EPUB 复用 section.search/find 逐章查找;PDF 逐页取文本层查找。
   * 只读操作:不改分页/进度/高亮/注释,不碰正文 DOM。
   */
  search(query: string): Promise<BookSearchResult[]>
  destroy(): void
}
