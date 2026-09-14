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
        sel.rangeCount = 0
        sel.collapsed = true
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

describe('退订', () => {
  it('teardown 之后,rendition 上一个订阅都不剩', async () => {
    const f = createFakeEpub()
    const engine = await openEngine()

    engine.destroy()

    // 引擎自己立的规矩:订上去的每一个都要在 teardown() 里还回去。少还一个,
    // 这份 rendition 就被一个已经作废的引擎钉在内存里,它发出来的事件还会打进
    // 旧引擎的分发逻辑。逐个点名,别只查其中几个。
    for (const type of [
      'relocated',
      'keydown',
      'mousedown',
      'touchstart',
      'mouseup',
      'touchend',
      'rendered'
    ]) {
      expect(f.hasHandler(type), `${type} 订了没退`).toBe(false)
    }
  })
})

describe('松手即划选', () => {
  /**
   * 鼠标事件的替身。node 里没有 MouseEvent,而"这一下是哪个键松开的"恰恰是引擎要
   * 看的字段,只能自己补上:0 是左键,2 是右键。
   */
  function mouseEvent(type: string, button = 0): Event {
    const e = new Event(type)
    Object.defineProperty(e, 'button', { value: button })
    return e
  }

  /** 订上一个只记账的划选订阅者,返回它收到的东西。 */
  function watch(engine: ReaderEngine): { cfiRange: string; text: string }[] {
    const seen: { cfiRange: string; text: string }[] = []
    engine.onSelected((cfiRange, text) => seen.push({ cfiRange, text }))
    return seen
  }

  it('书内容里松手,选中的那段文字进入订阅者手里,选区被收走', async () => {
    const f = createFakeEpub()
    const engine = await openEngine()
    const c = f.addContents('cfi-1', '他终于明白')
    const seen = watch(engine)

    f.emit('mouseup', mouseEvent('mouseup'))

    expect(seen).toEqual([{ cfiRange: 'cfi-1', text: '他终于明白' }])
    expect(c.selection.cleared).toBe(true)
  })

  it('手指松开(touchend)一样算一次划选', async () => {
    const f = createFakeEpub()
    const engine = await openEngine()
    f.addContents('cfi-1', '他终于明白')
    const seen = watch(engine)

    f.emit('touchend', new Event('touchend'))

    expect(
      seen,
      '手指和触控笔划完一段文字的最后一步是 touchend 不是 mouseup;只听 mouseup 的话,触摸屏上划选完全没有任何反应'
    ).toHaveLength(1)
  })

  it('外层界面上的松开,只有这一次按下落在书内容里时才算一次划选的结束', async () => {
    const f = createFakeEpub()
    const engine = await openEngine()
    const c = f.addContents('cfi-1', '他终于明白')
    const seen = watch(engine)

    // 用键盘选中了一段话,然后随手去点工具栏上的按钮:按下和松开都落在外层界面上。
    fakeWindow.dispatchEvent(new Event('mousedown'))
    fakeWindow.dispatchEvent(mouseEvent('mouseup'))

    expect(
      seen,
      '这一下松开跟书里那段选区毫无关系,却把它悄悄变成了一条引用——用户既没打算引用它,也不知道自己刚引用了什么'
    ).toEqual([])
    expect(c.selection.cleared).toBe(false)

    // 真的从书里开始、拖出 iframe 才松手:这一次才算数。
    f.emit('mousedown', new Event('mousedown'))
    fakeWindow.dispatchEvent(mouseEvent('mouseup'))

    expect(seen).toHaveLength(1)
  })

  it('按下的不是左键,松开就不算一次划选', async () => {
    const f = createFakeEpub()
    const engine = await openEngine()
    const c = f.addContents('cfi-1', '他终于明白')
    const seen = watch(engine)

    // 用键盘(或者双击)选中了一段话,想右键复制:右键按下弹出菜单,松开落在书内容里。
    f.emit('mouseup', mouseEvent('mouseup', 2))

    expect(
      seen,
      '右键松开被当成了一次拖选的结束:菜单还没点,这段话已经变成引用、选区也被收走了,用户想做的复制彻底做不成'
    ).toEqual([])
    expect(c.selection.cleared).toBe(false)

    // 左键松开才算数。
    f.emit('mouseup', mouseEvent('mouseup'))
    expect(seen).toHaveLength(1)
  })

  it('两份章节文档各自的选区都要处理,不能碰到第一份就收工', async () => {
    const f = createFakeEpub()
    const engine = await openEngine()
    const left = f.addContents('cfi-left', '左页这一句')
    const right = f.addContents('cfi-right', '右页这一句')
    const seen = watch(engine)

    f.emit('mouseup', mouseEvent('mouseup'))

    expect(
      seen.map((q) => q.cfiRange),
      '双页排版下两份文档各有各的选区。只收第一份的话,另一份里那段会一直留着,等用户下一次在别处松手才被翻出来,变成一段莫名其妙冒出来的引用'
    ).toEqual(['cfi-left', 'cfi-right'])
    expect(left.selection.cleared).toBe(true)
    expect(right.selection.cleared).toBe(true)
  })

  it('订阅者抛异常时选区还留着,用户手里至少还有可复制的文字', async () => {
    const f = createFakeEpub()
    const engine = await openEngine()
    const c = f.addContents('cfi-1', '他终于明白')
    engine.onSelected(() => {
      throw new Error('订阅者炸了')
    })

    // 这是鼠标事件的回调,没有任何调用栈接得住这个异常。
    expect(() => f.emit('mouseup', mouseEvent('mouseup'))).toThrow('订阅者炸了')

    expect(
      c.selection.cleared,
      '先收选区再通知的话,订阅者一炸,引用没加上、选区也没了,用户刚拖出来的那段话连复制都做不到'
    ).toBe(false)
  })

  it('消费掉选区之后,章节文档上紧跟着的那一下 click 被吞掉,下一次按下解除它', async () => {
    const f = createFakeEpub()
    const engine = await openEngine()
    const c = f.addContents('cfi-1', '他终于明白')
    watch(engine)

    f.emit('mouseup', mouseEvent('mouseup'))

    // marks-pane 的替身:它在章节文档上挂的转发是冒泡阶段,永远排在引擎那个捕获
    // 阶段的监听后面。这里在同一个 EventTarget 上后注册来代表这个先后关系;真实
    // 的捕获/冒泡先后由端到端测试在真 iframe 里证明。
    let forwarded = 0
    c.document.addEventListener('click', () => {
      forwarded++
    })

    c.document.dispatchEvent(new Event('click'))
    expect(forwarded).toBe(0)

    // 吞掉的只有紧挨着的那一下:再点就该转发出去了。
    c.document.dispatchEvent(new Event('click'))
    expect(forwarded).toBe(1)
  })

  it('补发的那一下 click 没来,下一次按下也会把吞噬解除掉', async () => {
    const f = createFakeEpub()
    const engine = await openEngine()
    const c = f.addContents('cfi-1', '他终于明白')
    watch(engine)

    f.emit('mouseup', mouseEvent('mouseup'))

    let forwarded = 0
    c.document.addEventListener('click', () => {
      forwarded++
    })

    // 拖出了 iframe 才松手,补发的那一下 click 落在外层文档上,章节文档这边一直没来。
    // 用户接着去点这块高亮:按下 → 松开 → click,这一下必须点得到。
    c.document.dispatchEvent(new Event('mousedown'))
    c.document.dispatchEvent(new Event('click'))

    expect(
      forwarded,
      '解除时机要是靠定时器上的毫秒数,机器一卡就会把用户真正想点的那一下吞掉'
    ).toBe(1)
  })
})
