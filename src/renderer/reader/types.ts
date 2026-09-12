export type ThemeName = 'light' | 'dark'

export interface TocItem {
  label: string
  href: string
  depth: number
}

export interface VisibleRange {
  /** 屏幕上当前可见的正文纯文本 */
  text: string
  startCfi: string
  endCfi: string
  /** 由 startCfi/endCfi 合成的范围 CFI;合成失败时为空字符串 */
  rangeCfi: string
  /** 当前所在章节的文件路径 */
  chapterHref: string
  /** 当前章节标题,目录里查不到时为 null */
  chapterLabel: string | null
  /** 页码 = 位置索引 + 1,不随字号变化 */
  page: number
  totalPages: number
}

export interface OpenOptions {
  fontSize: number
  theme: ThemeName
  /** 上次存下的位置索引,有就直接用,免去重新计算 */
  savedLocations: string | null
}

export interface ReaderEngine {
  open(data: ArrayBuffer, opts: OpenOptions): Promise<void>
  display(target?: string): Promise<void>
  next(): Promise<void>
  prev(): Promise<void>
  setSpread(on: boolean): Promise<void>
  setFontSize(px: number): void
  setTheme(name: ThemeName): void
  getVisible(): Promise<VisibleRange>
  toc(): TocItem[]
  currentCfi(): string | null
  exportLocations(): string | null
  onRelocated(cb: () => void): () => void
  /** 订阅按键:同时接收外层 window 和书内容 iframe 文档里发生的 keydown。返回取消订阅函数。 */
  onKey(cb: (key: string) => void): () => void
  destroy(): void
}
