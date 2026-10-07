/**
 * 整书 AI 翻译的内容分句工具（主进程与渲染层共用纯函数）。
 *
 * 设计：缓存单位是“内容分句”而非“页面”，分句只由正文内容决定、与排版无关。
 * - 同一句话在本页/下一页/改字号后的任何页面出现，分句结果都相同 → 缓存命中，不调模型。
 * - 翻回已译页面：分句全命中 → 零 IPC、零模型调用。
 * - 改字号：新页面 = 已缓存分句（迁移过来的内容）+ 未缓存分句（新露出的内容），
 *   只翻译未缓存的部分，组装时拼接到一起。
 * - “记号”即分句缓存行的存在：查到即不翻译。
 */

export interface BookTranslationPage {
  page: number
  totalPages?: number
  startCfi?: string
}

export interface BookSegmentRecord {
  bookId: string
  segHash: string
  sourceText: string
  translatedText: string
  engine: string
  updatedAt: number
}

/** 空白归一化：与引擎 getVisible 的收敛方式一致，缓存比对都走它。 */
export function normalizeBookText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

const SENTENCE_END = /[。！？!?.…；;]/
const MAX_SEGMENT_CHARS = 1200

/**
 * 把一页正文切成稳定的内容分句：按句末标点切分（标点归前一句），超长句按长度硬切。
 * 纯内容函数：同样文字在任何页面、任何字号下切分结果都相同。
 */
export function splitBookSegments(text: string): string[] {
  const source = normalizeBookText(text)
  if (!source) return []
  const sentences: string[] = []
  let current = ''
  for (const char of source) {
    current += char
    // 句末标点结算：切分只与内容有关。紧跟标点的右引号会被归入下一句开头，
    // 不影响正确性（分句在任何排版下都稳定），故不做特殊前瞻处理。
    if (SENTENCE_END.test(char)) {
      sentences.push(current)
      current = ''
    }
  }
  if (current.trim()) sentences.push(current)
  const out: string[] = []
  for (const sentence of sentences) {
    const trimmed = sentence.trim()
    if (!trimmed) continue
    if (trimmed.length <= MAX_SEGMENT_CHARS) {
      out.push(trimmed)
      continue
    }
    // 超长句（无标点的病态长句）按长度硬切：仍只与内容有关，与排版无关。
    let rest = trimmed
    while (rest.length > MAX_SEGMENT_CHARS) {
      let cut = MAX_SEGMENT_CHARS
      const space = rest.lastIndexOf(' ', MAX_SEGMENT_CHARS)
      if (space > MAX_SEGMENT_CHARS * 0.5) cut = space + 1
      out.push(rest.slice(0, cut).trim())
      rest = rest.slice(cut).trim()
    }
    if (rest) out.push(rest)
  }
  return out.filter((s) => s.length > 0)
}

/**
 * 组装一页译文：分句译文按原文顺序拼接。
 * 译文按契约恒为简体中文，中文语境下分句间不加空格（与原文观感一致）。
 */
export function joinSegmentTranslations(translated: string[]): string {
  return translated.join('')
}

/**
 * 把缺失分句按字符量装箱：每批不超过 maxChars，分句不拆散（单个超长分句自成一批）。
 * 纯函数，调用方一批对应一次模型调用。
 */
export function batchSegments(segments: string[], maxChars: number): string[][] {
  const batches: string[][] = []
  let current: string[] = []
  let size = 0
  for (const segment of segments) {
    if (current.length > 0 && size + segment.length > maxChars) {
      batches.push(current)
      current = []
      size = 0
    }
    current.push(segment)
    size += segment.length
  }
  if (current.length > 0) batches.push(current)
  return batches
}

/**
 * 当前可见页的视图身份键（仅用于把译文覆盖层对齐到当前页，不是缓存键）。
 * - PDF 按物理页码；EPUB/TXT 按起点 CFI。
 */
export function visiblePageKey(visible: BookTranslationPage, isPdf: boolean): string {
  if (isPdf) {
    const page = Number.isFinite(visible.page) && visible.page > 0 ? Math.floor(visible.page) : 1
    return `pdf-page-${page}`
  }
  const start = typeof visible.startCfi === 'string' && visible.startCfi ? visible.startCfi : 'start'
  return `epub-${start}`
}

/** 下一物理页页码：PDF 可直接算出；EPUB 需翻页后才知道，返回 null。 */
export function nextPdfPage(visible: BookTranslationPage, isPdf: boolean): number | null {
  if (!isPdf) return null
  const page = Math.floor(visible.page)
  const total = Math.floor(visible.totalPages ?? 0)
  if (!Number.isFinite(page) || page < 1) return null
  if (Number.isFinite(total) && total > 0 && page >= total) return null
  return page + 1
}

/** 单页原文长度上限（与划词翻译的 10000 字保持一致）。 */
export const MAX_BOOK_PAGE_CHARS = 10000
/** 单次模型调用最多携带的字符量（分句不拆散）。 */
export const MAX_SEGMENT_BATCH_CHARS = 2500
/** 单次 ensure 调用最多携带的分句数（病态页面兜底）。 */
export const MAX_SEGMENTS_PER_ENSURE = 300
