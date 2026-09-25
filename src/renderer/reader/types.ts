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
  /** 当前排版下估算的全书页码，字号和阅读区域变化时重新计算 */
  page: number
  /** 当前排版下估算的全书总页数 */
  totalPages: number
}

export interface OpenOptions {
  fontSize: number
  theme: ThemeName
  /** 上次存下的位置索引,有就直接用,免去重新计算 */
  savedLocations: string | null
}

export interface SelectionPoint {
  x: number
  y: number
}

export interface ReaderEngine {
  open(data: ArrayBuffer, opts: OpenOptions): Promise<void>
  display(target?: string): Promise<void>
  next(): Promise<void>
  prev(): Promise<void>
  setSpread(on: boolean): Promise<void>
  setFontSize(px: number, anchorCfi?: string): void | Promise<void>
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
  /** 给一段范围加高亮;点击该高亮时调用 onClick。同一段范围重复加会先抹掉旧的那层。 */
  addHighlight(cfiRange: string, onClick: () => void): void
  /** 抹掉一段范围的高亮;这段范围本来就没高亮时什么也不做。 */
  removeHighlight(cfiRange: string): void
  /** 抹掉当前这本书上所有由本引擎加过的高亮。 */
  clearHighlights(): void
  destroy(): void
}
