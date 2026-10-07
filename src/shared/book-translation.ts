export interface BookTranslationPage {
  page: number
  totalPages?: number
  startCfi?: string
}

export interface BookTranslationRecord {
  bookId: string
  pageKey: string
  sourceText: string
  translatedText: string
  engine: string
  updatedAt: number
}

/**
 * 书籍整页翻译的缓存键（纯函数，主进程与渲染层共用）。
 *
 * - PDF 按物理页码：`pdf-page-N`，版式固定，翻页即换键。
 * - EPUB/TXT 按当前可见范围的起点 CFI：`epub-<startCfi>`，排版变化导致
 *   分页移动时会产生新键，旧缓存保留不删（用户要求），下次命中即复用。
 *
 * 键本身不含正文 hash：同一键命中但正文变化时，主进程按存下的 sourceText
 * 比对后更新缓存（upsert），避免排版微调后展示错位的译文。
 */
export function bookTranslationKey(visible: BookTranslationPage, isPdf: boolean): string {
  if (isPdf) {
    const page = Number.isFinite(visible.page) && visible.page > 0 ? Math.floor(visible.page) : 1
    return `pdf-page-${page}`
  }
  const start = typeof visible.startCfi === 'string' && visible.startCfi ? visible.startCfi : 'start'
  return `epub-${start}`
}

/** 下一页的缓存键：PDF 可直接算出；EPUB 需翻页后才能知道，返回 null。 */
export function nextBookTranslationKey(visible: BookTranslationPage, isPdf: boolean): string | null {
  if (!isPdf) return null
  const page = Math.floor(visible.page)
  const total = Math.floor(visible.totalPages ?? 0)
  if (!Number.isFinite(page) || page < 1) return null
  if (Number.isFinite(total) && total > 0 && page >= total) return null
  return `pdf-page-${page + 1}`
}

/** 单页原文长度上限（与划词翻译的 10000 字保持一致）。 */
export const MAX_BOOK_PAGE_CHARS = 10000
