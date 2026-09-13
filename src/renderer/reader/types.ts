export type ThemeName = 'light' | 'dark'

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
  /** 由 startCfi/endCfi 合成的范围 CFI;合成失败时为空字符串,此时 approximate 为 true */
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
