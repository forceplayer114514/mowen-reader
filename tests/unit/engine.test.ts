import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReaderEngine } from '../../src/renderer/reader/types'

/**
 * 这个文件测的是引擎和 epub.js 之间那层交互本身:什么时候该往它的标注表里写、
 * 什么时候一个字都不能写、松手之后那串鼠标事件被怎么处理。这些判断全都发生在
 * 引擎内部,从 selection store 那一侧的假引擎里根本看不见,而真实的 epub.js 又
 * 要一份真 EPUB、一个真 iframe 才跑得起来——所以这里把 epubjs 整个换成一个只
 * 负责如实记账的替身,断言的是"引擎对它说了什么话、按什么顺序说的"。
 *
 * 替身只覆盖引擎真的会调到的那几个方法,不去模仿 epub.js 的行为,免得测到的
 * 变成替身自己。
 */

/** 引擎对 epub.js 标注表发出的一次调用。 */
interface AnnotationCall {
  op: 'highlight' | 'remove'
  cfiRange: string
  /** highlight 时传进去的配色;remove 时是那个不能省的类型字符串。 */
  detail?: string
}

const hub = vi.hoisted(() => ({ book: null as unknown }))

vi.mock('epubjs', () => ({ default: () => hub.book }))

// 引擎在 createEngine() 里就往外层窗口挂 keydown / mouseup,node 环境下没有 window,
// 这里给一个真的 EventTarget 顶上——它的 addEventListener/dispatchEvent 是真的,
// 所以"拖出 iframe 在外面松手"那条路也能照着派发事件走一遍。
let fakeWindow: EventTarget

/** 章节文档的替身。捕获阶段的先后在单个 EventTarget 上体现为注册顺序。 */
function fakeDocument(): Document {
  return new EventTarget() as unknown as Document
}

interface FakeSelection {
  rangeCount: number
  collapsed: boolean
  text: string
  cleared: boolean
}

interface FakeContents {
  document: Document
  selection: FakeSelection
  cfi: string
}

function createFakeEpub() {
  const calls: AnnotationCall[] = []
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>()
  const contents: FakeContents[] = []
  let viewCount = 1

  function makeSelection(sel: FakeSelection): unknown {
    return {
      rangeCount: sel.rangeCount,
      toString: () => sel.text,
      getRangeAt: () => ({ collapsed: sel.collapsed }),
      removeAllRanges: () => {
        sel.cleared = true
      }
    }
  }

  const rendition = {
    themes: { register: () => {}, select: () => {}, fontSize: () => {} },
    q: { stop: () => {} },
    annotations: {
      highlight(
        cfiRange: string,
        _data: object,
        _cb: () => void,
        _className: undefined,
        styles: Record<string, string>
      ): void {
        calls.push({ op: 'highlight', cfiRange, detail: styles.fill })
      },
      remove(cfiRange: string, type: string): void {
        calls.push({ op: 'remove', cfiRange, detail: type })
      }
    },
    views: () => ({ length: viewCount }),
    getContents: () =>
      contents.map((c) => ({
        document: c.document,
        window: { getSelection: () => makeSelection(c.selection) },
        cfiFromRange: () => c.cfi
      })),
    on(type: string, cb: (...args: unknown[]) => void): void {
      const set = handlers.get(type) ?? new Set()
      set.add(cb)
      handlers.set(type, set)
    },
    off(type: string, cb: (...args: unknown[]) => void): void {
      handlers.get(type)?.delete(cb)
    },
    display: async (): Promise<void> => {},
    destroy: (): void => {}
  }

  hub.book = {
    ready: Promise.resolve(),
    loaded: { navigation: Promise.resolve({ toc: [] }) },
    packaging: { navPath: '', ncxPath: '' },
    spine: { each: (): void => {} },
    locations: { load: (): void => {} },
    renderTo: () => rendition,
    destroy: (): void => {}
  }

  return {
    calls,
    /** 把这一轮之前的调用清掉,只看接下来发生了什么。 */
    reset(): void {
      calls.length = 0
    },
    /** 调用序列的可读形式,比如 "remove cfi-1"。 */
    trace(): string[] {
      return calls.map((c) => `${c.op} ${c.cfiRange}`)
    },
    /** 现在渲染出来几个章节视图。0 表示一个都没有。 */
    setViewCount(n: number): void {
      viewCount = n
    },
    /** 往 rendition 上发一个 epub.js 会发的事件(rendered / mouseup / ...)。 */
    emit(type: string, ...args: unknown[]): void {
      for (const cb of [...(handlers.get(type) ?? [])]) cb(...args)
    },
    hasHandler(type: string): boolean {
      return (handlers.get(type)?.size ?? 0) > 0
    },
    /** 给这本书加一份章节文档,里面有一段选中的文字。 */
    addContents(cfi: string, text: string): FakeContents {
      const c: FakeContents = {
        document: fakeDocument(),
        selection: { rangeCount: 1, collapsed: false, text, cleared: false },
        cfi
      }
      contents.push(c)
      return c
    }
  }
}

const CONTAINER = { replaceChildren: (): void => {} } as unknown as HTMLElement

async function openEngine(): Promise<ReaderEngine> {
  const { createEngine } = await import('../../src/renderer/reader/engine')
  const engine = createEngine(CONTAINER)
  await engine.open(new ArrayBuffer(0), { fontSize: 18, theme: 'light', savedLocations: 'x' })
  return engine
}

beforeEach(() => {
  fakeWindow = new EventTarget()
  Object.defineProperty(globalThis, 'window', {
    value: fakeWindow,
    configurable: true,
    writable: true
  })
})

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window')
})

describe('高亮与 epub.js 标注表', () => {
  it('有章节视图时加高亮,先抹掉同一段旧的那层,再按当前主题画一层', async () => {
    const f = createFakeEpub()
    const engine = await openEngine()

    engine.addHighlight('cfi-1', () => {})

    expect(f.calls).toEqual([
      { op: 'remove', cfiRange: 'cfi-1', detail: 'highlight' },
      { op: 'highlight', cfiRange: 'cfi-1', detail: '#f2c14e' }
    ])
  })

  it('一个章节视图都没渲染出来时,取消高亮不去碰 epub.js 的标注表', async () => {
    const f = createFakeEpub()
    const engine = await openEngine()
    engine.addHighlight('cfi-1', () => {})
    f.reset()

    // 这一章翻走了,视图被销毁,页面上已经没有任何视图。
    f.setViewCount(0)
    engine.removeHighlight('cfi-1')

    expect(
      f.trace(),
      'epub.js 的 Annotations.remove() 把「从分组索引里摘掉」和「把 SVG 从视图上摘下来」都写在遍历当前视图的循环里,而「从总表里删掉」写在循环外面无条件执行;一个视图都没有的时候调它,总表没了记录、分组索引里那条还在,这一章再渲染出来时 inject() 会拿着 undefined 调 attach() 当场抛错,而那块矩形从此谁也摸不到'
    ).toEqual([])
  })

  it('欠着的那次取消,等下一次章节渲染出来时补上', async () => {
    const f = createFakeEpub()
    const engine = await openEngine()
    engine.addHighlight('cfi-1', () => {})
    f.setViewCount(0)
    engine.removeHighlight('cfi-1')
    f.reset()

    f.setViewCount(1)
    f.emit('rendered')

    // 只补一次摘除:账上已经没有这一段了,不该又被画回来。
    expect(f.trace()).toEqual(['remove cfi-1'])
  })

  it('书还没渲染出来时加的高亮,在章节渲染出来那一刻画上,不用等到换主题', async () => {
    const f = createFakeEpub()
    const engine = await openEngine()

    // open() 已经跑完、display() 还没跑,这段窗口里 rendition 在但一个视图都没有。
    f.setViewCount(0)
    engine.addHighlight('cfi-1', () => {})
    expect(f.trace()).toEqual([])

    f.setViewCount(1)
    f.emit('rendered')

    expect(f.trace()).toEqual(['remove cfi-1', 'highlight cfi-1'])
  })

  it('没有视图的时候换主题,同样一个字都不往标注表里写', async () => {
    const f = createFakeEpub()
    const engine = await openEngine()
    engine.addHighlight('cfi-1', () => {})
    f.reset()

    f.setViewCount(0)
    engine.setTheme('dark')

    expect(f.trace()).toEqual([])
  })

  it('换主题时按新配色重画', async () => {
    const f = createFakeEpub()
    const engine = await openEngine()
    engine.addHighlight('cfi-1', () => {})
    f.reset()

    engine.setTheme('dark')

    expect(f.calls).toEqual([
      { op: 'remove', cfiRange: 'cfi-1', detail: 'highlight' },
      { op: 'highlight', cfiRange: 'cfi-1', detail: '#7aa2f7' }
    ])
  })

  it('清空所有高亮时,没有视图就一次也不调移除,等渲染出来再一起补', async () => {
    const f = createFakeEpub()
    const engine = await openEngine()
    engine.addHighlight('cfi-1', () => {})
    engine.addHighlight('cfi-2', () => {})
    f.reset()

    f.setViewCount(0)
    engine.clearHighlights()
    expect(f.trace()).toEqual([])

    f.setViewCount(1)
    f.emit('rendered')
    expect(f.trace().sort()).toEqual(['remove cfi-1', 'remove cfi-2'])
  })
})
