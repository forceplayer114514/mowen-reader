import { describe, expect, it, vi } from 'vitest'
import { createSelectionStore } from '../../src/renderer/reader/selection'
import type { ReaderEngine } from '../../src/renderer/reader/types'

function fakeEngine() {
  const highlights = new Map<string, () => void>()
  let selectedCb: ((cfiRange: string, text: string) => void) | null = null
  const engine = {
    onSelected: (cb: (cfiRange: string, text: string) => void) => {
      selectedCb = cb
      return () => {
        selectedCb = null
      }
    },
    addHighlight: (cfiRange: string, onClick: () => void) => highlights.set(cfiRange, onClick),
    removeHighlight: (cfiRange: string) => void highlights.delete(cfiRange),
    clearHighlights: () => highlights.clear()
  } as unknown as ReaderEngine
  return {
    engine,
    highlights,
    select: (cfiRange: string, text: string) => selectedCb?.(cfiRange, text),
    clickHighlight: (cfiRange: string) => highlights.get(cfiRange)?.(),
    hasSubscriber: () => selectedCb !== null
  }
}

describe('划选引用', () => {
  it('刚创建时没有任何引用', () => {
    const f = fakeEngine()
    expect(createSelectionStore(f.engine).list()).toEqual([])
  })

  it('拖选一句话后它进入引用列表并被高亮', () => {
    const f = fakeEngine()
    const store = createSelectionStore(f.engine)
    f.select('cfi-1', '他终于明白')
    expect(store.list()).toEqual([{ cfiRange: 'cfi-1', text: '他终于明白' }])
    expect(f.highlights.has('cfi-1')).toBe(true)
  })

  it('多句可以同时选中,按选中顺序排列', () => {
    const f = fakeEngine()
    const store = createSelectionStore(f.engine)
    f.select('cfi-1', '第一句')
    f.select('cfi-2', '第二句')
    expect(store.list().map((q) => q.text)).toEqual(['第一句', '第二句'])
  })

  it('点击已高亮的句子取消它', () => {
    const f = fakeEngine()
    const store = createSelectionStore(f.engine)
    f.select('cfi-1', '他终于明白')
    f.clickHighlight('cfi-1')
    expect(store.list()).toEqual([])
    expect(f.highlights.has('cfi-1')).toBe(false)
  })

  it('重复选中同一段是取消而不是加两次', () => {
    const f = fakeEngine()
    const store = createSelectionStore(f.engine)
    f.select('cfi-1', '他终于明白')
    f.select('cfi-1', '他终于明白')
    expect(store.list()).toEqual([])
  })

  it('clear 清空列表并抹掉页面上所有高亮', () => {
    const f = fakeEngine()
    const store = createSelectionStore(f.engine)
    f.select('cfi-1', '第一句')
    f.select('cfi-2', '第二句')
    store.clear()
    expect(store.list()).toEqual([])
    expect(f.highlights.size).toBe(0)
  })

  it('订阅者在每次变化时收到最新列表', () => {
    const f = fakeEngine()
    const store = createSelectionStore(f.engine)
    const seen: number[] = []
    store.subscribe((q) => seen.push(q.length))
    f.select('cfi-1', 'a')
    f.select('cfi-2', 'b')
    store.clear()
    expect(seen).toEqual([1, 2, 0])
  })

  it('取消订阅后不再收到通知', () => {
    const f = fakeEngine()
    const store = createSelectionStore(f.engine)
    const cb = vi.fn()
    const off = store.subscribe(cb)
    off()
    f.select('cfi-1', 'a')
    expect(cb).not.toHaveBeenCalled()
  })

  it('在一个订阅者的回调里退掉另一个订阅者,后者当轮就不该再收到通知', () => {
    const f = fakeEngine()
    const store = createSelectionStore(f.engine)
    const seen: string[] = []
    let offSecond: (() => void) | null = null
    store.subscribe(() => {
      seen.push('第一个')
      offSecond?.()
    })
    offSecond = store.subscribe(() => {
      seen.push('第二个')
    })
    f.select('cfi-1', '他终于明白')
    // 退订是用 filter 生成一个新数组再重新赋值的。分发时如果直接遍历那个变量,
    // for...of 拿住的还是赋值前的旧数组,已经退订的人照样会收到这一轮——
    // 对一个正因为要卸载才退订的订阅者来说,这一轮通知来得太晚了。
    expect(seen).toEqual(['第一个'])
  })

  it('dispose 会退订引擎,之后的拖选不再进入列表', () => {
    const f = fakeEngine()
    const store = createSelectionStore(f.engine)
    store.dispose()
    expect(f.hasSubscriber()).toBe(false)
  })

  it('dispose 还要把页面上剩下的高亮抹掉', () => {
    const f = fakeEngine()
    const store = createSelectionStore(f.engine)
    f.select('cfi-1', '第一句')
    f.select('cfi-2', '第二句')
    store.dispose()
    // 引擎可能活得比 store 久(侧边栏关掉了、书还开着)。只退订、只清列表的话,
    // 那几块高亮会留在页面上,而且每块身上还挂着这个已经作废的 store 的 toggle:
    // 点一下,它在空列表里找不到这段范围,于是走"加入"分支把高亮又画回来,
    // 再也没人跟踪它,也就再也点不掉了。
    expect(f.highlights.size).toBe(0)
  })

  it('选中空白文本被忽略', () => {
    const f = fakeEngine()
    const store = createSelectionStore(f.engine)
    f.select('cfi-1', '   ')
    expect(store.list()).toEqual([])
  })
})
