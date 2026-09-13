import type { QuoteRecord } from '@shared/types'
import type { ReaderEngine } from './types'

/**
 * 管理"这几句要发给 AI"的临时标记。
 *
 * 规则:拖选松开即高亮进列表,点击已高亮的句子取消,重复选中同一段等于取消。
 * 这些高亮不存盘、关书即消失——它不是笔记功能,只是一次提问的附件。
 */
export function createSelectionStore(engine: ReaderEngine): {
  subscribe(cb: (quotes: QuoteRecord[]) => void): () => void
  list(): QuoteRecord[]
  toggle(cfiRange: string, text: string): void
  clear(): void
  dispose(): void
} {
  let quotes: QuoteRecord[] = []
  let listeners: ((q: QuoteRecord[]) => void)[] = []

  function notify(): void {
    const snapshot = [...quotes]
    for (const cb of listeners) cb(snapshot)
  }

  function toggle(cfiRange: string, text: string): void {
    const trimmed = text.trim()
    if (trimmed.length === 0) return
    const at = quotes.findIndex((q) => q.cfiRange === cfiRange)
    if (at >= 0) {
      quotes = quotes.filter((q) => q.cfiRange !== cfiRange)
      engine.removeHighlight(cfiRange)
    } else {
      quotes = [...quotes, { cfiRange, text: trimmed }]
      engine.addHighlight(cfiRange, () => toggle(cfiRange, trimmed))
    }
    notify()
  }

  const offSelected = engine.onSelected(toggle)

  return {
    subscribe(cb): () => void {
      listeners.push(cb)
      return () => {
        listeners = listeners.filter((x) => x !== cb)
      }
    },
    list: () => [...quotes],
    toggle,
    clear(): void {
      quotes = []
      engine.clearHighlights()
      notify()
    },
    dispose(): void {
      offSelected()
      listeners = []
      quotes = []
      // 引擎可能活得比这个 store 久(侧边栏关掉了、书还开着)。不抹掉高亮的话,
      // 页面上那几块会一直留着,而且每块身上还挂着这个已经作废的 store 的 toggle:
      // 点一下,它在空列表里找不到这段范围,于是走"加入"分支把高亮又画回来,
      // 再也没人跟踪它,也就再也点不掉了。
      engine.clearHighlights()
    }
  }
}
