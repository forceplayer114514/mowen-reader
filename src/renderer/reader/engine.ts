import ePub, { type Book, type Contents, type NavItem, type Rendition } from 'epubjs'
import { makeRangeCfi } from './cfi'
import type { OpenOptions, ReaderEngine, ThemeName, TocItem, VisibleRange } from './types'

const THEMES: Record<ThemeName, Record<string, Record<string, string>>> = {
  light: {
    body: { color: '#1a1a1a', background: '#faf8f5' },
    a: { color: '#1a5fb4' }
  },
  dark: {
    body: { color: '#d6d3cd', background: '#1c1b19' },
    a: { color: '#7aa2f7' }
  }
}

/** 位置索引的切分粒度。数字越小页数越多、生成越慢。1000 字符约等于一屏中文。 */
const LOCATION_CHUNK = 1000

/**
 * epub.js 的类型声明里 Locations.locationFromCfi() 返回值标成了 DOM 的 Location 类型,
 * Locations.total 字段又完全没声明,两处都是类型包本身的疏漏(运行时其实就是 number)。
 * 这里declare 一个只描述我们用到的字段的局部接口,把 book.locations 断言过去,
 * 而不是放宽 types.ts 里对外的类型。
 */
interface LocationsWithTotal {
  total: number
  locationFromCfi(cfi: string): number
}

export function createEngine(container: HTMLElement): ReaderEngine {
  let book: Book | null = null
  let rendition: Rendition | null = null
  let toc: TocItem[] = []
  let listeners: (() => void)[] = []
  let keyListeners: ((key: string) => void)[] = []
  let locationsReady = false
  // 每次 open()/destroy() 自增一次,给这次调用发出的所有异步延续盖一个“批次号”。
  // 延续恢复执行时先比对批次号,号不一样说明这次 open 已经被下一次 open 或 destroy 取代,
  // 直接放弃、不再碰任何闭包变量——用来防止过期的 open() 续写覆盖新书的状态。
  let generation = 0

  function flatToc(items: NavItem[], depth: number, out: TocItem[]): void {
    for (const item of items) {
      out.push({ label: String(item.label ?? '').trim(), href: String(item.href ?? ''), depth })
      if (Array.isArray(item.subitems) && item.subitems.length > 0) {
        flatToc(item.subitems, depth + 1, out)
      }
    }
  }

  function notify(): void {
    for (const cb of listeners) cb()
  }

  function notifyKey(key: string): void {
    for (const cb of keyListeners) cb(key)
  }

  /**
   * 处理外层窗口(阅读界面的按钮、工具栏等,不在 epub.js 的 iframe 里)上的 keydown。
   * 从 createEngine() 调用起就订阅,直到 destroy() 才取消——与某一次 open() 的
   * book/rendition 无关,所以不放在 open() 里注册。
   */
  function handleWindowKeydown(e: KeyboardEvent): void {
    notifyKey(e.key)
  }

  /**
   * 处理书本内容(epub.js 渲染进 iframe 里的文档)上的 keydown。
   *
   * epub.js 的 Rendition 构造函数里默认把 passEvents 注册到 hooks.content(见
   * node_modules/epubjs/src/rendition.js 的 constructor 和 passEvents 方法):每次一个
   * 章节的 iframe 文档渲染完成,Contents 实例会在自己的 document 上挂 DOM_EVENTS 列表
   * (包含 keydown,见 utils/constants.js 和 contents.js 的 addEventListeners),再把
   * 收到的原生事件通过 rendition.emit(e.type, e, contents) 转发到 rendition 自己身上。
   * 也就是说 rendition.on('keydown', cb) 不需要我们自己再往每个渲染文档上挂监听器——
   * 库本身已经把书内容 iframe 里的按键转发出来了,cb 收到的就是原生 KeyboardEvent。
   * Contents.addEventListeners()/removeEventListeners() 由 epub.js 在每次渲染/卸载
   * 文档时自动管理,所以翻页、换章节都不会导致这里的监听重复挂载。
   */
  function handleContentKeydown(e: KeyboardEvent): void {
    notifyKey(e.key)
  }

  window.addEventListener('keydown', handleWindowKeydown)

  /**
   * 释放某次 open() 调用在本地创建、但还没发布到闭包变量就被取代的 book/rendition。
   * 用在 open() 里每一处 `epoch !== generation` 判断为真之后、return 之前。
   *
   * 光调用 rendition.destroy() 并不够:epub.js 的 Rendition.destroy()(见
   * node_modules/epubjs/src/rendition.js)里清空自身任务队列的那行 `this.q.clear()`
   * 是注释掉的——它自己排队等 book.opened 之后要跑的 start()/attachTo() 渲染步骤
   * 不会被这次 destroy() 打断。也就是说,如果这次 open() 在 manager.render() 真正
   * 执行之前就已经过期,那个 render() 调用仍会按原计划在之后的某一帧触发,往容器里
   * 插入一个没人认领的 stage 元素(iframe 的父容器)、注册永久性的 window
   * resize/orientationchange 监听(见 managers/helpers/stage.js 的 onResize /
   * onOrientationChange)。所以这里先调用 q.stop() 清空并冻结这个内部队列,不让它
   * 继续往下跑;render() 如果已经先一步执行完,再靠 destroy() 去清已经建出来的
   * manager/stage。
   *
   * 如果 render() 还没执行到,manager 可能已经被 start() 建出来但
   * manager.container/manager.stage 还没有——这种半成品状态下 epub.js 自带的
   * DefaultViewManager.destroy() 会直接访问 this.container(在
   * removeEventListeners() 里)和 this.stage(destroy() 最后一行),两者都还是
   * undefined,会抛 TypeError。这里用 try/catch 兜底,不能让清理旧对象的动作把
   * open() 的调用方炸掉。
   */
  function destroyStale(staleBook: Book, staleRendition: Rendition): void {
    staleRendition.q.stop()
    staleRendition.off('keydown', handleContentKeydown)
    try {
      staleRendition.destroy()
    } catch {
      // 忽略:render() 还没跑到,没有 manager/stage 可清
    }
    try {
      staleBook.destroy()
    } catch {
      // 忽略:与上面同理
    }
  }

  /**
   * 销毁当前的 rendition/book,清空容器,把状态复位到初始值。
   * 供 open()(重新打开前先清场)和 destroy()(退出阅读界面)共用。
   * 注意:这不是对外的 destroy() ——它不清空 listeners,重新 open 之后旧的
   * onRelocated 订阅者应当继续收到新书的通知。
   */
  function teardown(): void {
    rendition?.off('keydown', handleContentKeydown)
    // rendition.q 里可能还排着一个我们自己调用过、还没跑到的 display() 任务(见
    // ReaderView.boot() 里 `await engine.display(...)`):它是 epub.js 内部靠
    // requestAnimationFrame 驱动的队列,当前这一帧不一定跑得到它。如果不在这里
    // 先 q.stop() 清空排队项,这个任务会在之后某一帧才真正执行到
    // Rendition._display(),届时下面 book.destroy() 已经把 book.locations 内部
    // 状态清掉了,但 rendition.book 这个引用本身没变,_display() 一开始就会摸
    // `this.book.locations.length()`,对着已销毁的 Locations 抛 TypeError——这是
    // 一次脱离了当前调用栈的异步执行,没有任何 try/catch 接得住,会变成未捕获的
    // 全局异常,把整个 React 渲染树崩掉。跟 destroyStale() 里对新书 stale
    // rendition 做的处理一样,先停队列,把还没跑的任务直接扔掉。
    rendition?.q.stop()
    // rendition/book 在这里可能和 destroyStale() 里一样是"半成品"状态:open() 已经
    // 把它们发布到闭包变量(book = nextBook; rendition = nextRendition 那一步已经跑
    // 过),但 epub.js 内部 manager.render() 还没真正跑完——render() 之前
    // DefaultViewManager 的 this.container 还是 undefined,它自己的
    // removeEventListeners() 会直接对 undefined 调用 removeEventListener 抛
    // TypeError(见上面 destroyStale() 的注释)。这条路径此前没有 try/catch,
    // 用户在 boot() 还没跑完时就点击返回书架,会让这个 TypeError 从 React 的
    // effect 清理函数里原样抛出去、没有任何错误边界接住,把整个渲染树崩掉、
    // 界面变成一片空白且再也回不去书架。跟 destroyStale() 一样兜底,不能让
    // 清理旧对象的动作把调用方炸掉。
    try {
      rendition?.destroy()
    } catch {
      // 忽略:render() 还没跑到,没有 manager/stage 可清
    }
    try {
      book?.destroy()
    } catch {
      // 忽略:与上面同理
    }
    // epub.js 的 Stage.attachTo 只会往容器里追加自己的 stage 元素,不会清理旧的,
    // 所以这里手动清空容器,否则连续 open() 会在 DOM 里叠出多个 iframe。
    container.replaceChildren()
    rendition = null
    book = null
    toc = []
    locationsReady = false
  }

  return {
    async open(data: ArrayBuffer, opts: OpenOptions): Promise<void> {
      teardown()
      const epoch = ++generation

      const nextBook = ePub(data)
      const nextRendition = nextBook.renderTo(container, {
        width: '100%',
        height: '100%',
        flow: 'paginated',
        spread: 'none',
        allowScriptedContent: false
      })
      nextRendition.themes.register('light', THEMES.light)
      nextRendition.themes.register('dark', THEMES.dark)
      nextRendition.themes.select(opts.theme)
      nextRendition.themes.fontSize(`${opts.fontSize}px`)

      await nextBook.ready
      // destroy() 或另一次 open() 可能在 await 期间抢先执行,批次号已经变了就不再往下走,
      // 避免对已经被 teardown 过的 book/rendition 继续操作。
      // 这次 open() 已经被取代,但 nextBook/nextRendition 是它自己 new 出来的本地对象,
      // 从没发布到闭包变量,teardown() 根本碰不到它们——必须在这里主动释放,否则
      // epub.js 内部队列会在 book.opened resolve 之后继续插入 iframe、注册永久监听。
      if (epoch !== generation) {
        destroyStale(nextBook, nextRendition)
        return
      }

      const nav = await nextBook.loaded.navigation
      if (epoch !== generation) {
        destroyStale(nextBook, nextRendition)
        return
      }

      const items: TocItem[] = []
      flatToc(nav.toc, 0, items)

      // 到这里两次 epoch 检查都通过,这次 open() 没有被取代,才正式发布到闭包变量。
      book = nextBook
      rendition = nextRendition
      toc = items

      if (opts.savedLocations) {
        nextBook.locations.load(opts.savedLocations)
        locationsReady = true
      } else {
        void nextBook.locations.generate(LOCATION_CHUNK).then(() => {
          // 同一本书可能因为 open() 被再次调用而在 generate() 完成前就已经过期,
          // 这里必须再查一次批次号,否则旧书生成完成的那一刻会把 locationsReady
          // 错误地置为 true,污染的是新书(或已销毁状态)的读数。
          // 此时 nextBook/nextRendition 通常已经被后来的 teardown() 当作
          // book/rendition 销毁过一次,但那两个闭包变量已经指向别的对象或 null,
          // 这里手上的本地引用还在——统一走 destroyStale() 再销毁一次,
          // epub.js 内部对重复 destroy() 有 `this.xxx &&` 式的判空保护,不会出错。
          if (epoch !== generation) {
            destroyStale(nextBook, nextRendition)
            return
          }
          locationsReady = true
          notify()
        })
      }

      nextRendition.on('relocated', notify)
      // 见上面 handleContentKeydown 的注释:这一行订阅之后,书内容 iframe 里发生的
      // keydown 会被 epub.js 自己转发到这里,不需要我们逐个文档去挂监听器。
      nextRendition.on('keydown', handleContentKeydown)
    },

    async display(target?: string): Promise<void> {
      if (!rendition) throw new Error('书还没打开')
      await rendition.display(target)
    },

    async next(): Promise<void> {
      await rendition?.next()
    },

    async prev(): Promise<void> {
      await rendition?.prev()
    },

    async setSpread(on: boolean): Promise<void> {
      if (!rendition) return
      rendition.spread(on ? 'auto' : 'none')
      // 切换后当前位置需要重新落位,否则可能停在半页
      const cfi = rendition.location?.start?.cfi
      if (cfi) await rendition.display(cfi)
    },

    setFontSize(px: number): void {
      rendition?.themes.fontSize(`${px}px`)
    },

    setTheme(name: ThemeName): void {
      rendition?.themes.select(name)
    },

    async getVisible(): Promise<VisibleRange> {
      if (!book || !rendition?.location) throw new Error('书还没打开')
      const { start, end } = rendition.location

      let text = ''
      let rangeCfi = ''
      try {
        // makeRangeCfi 在 CFI 不合法、缺少章节分隔符、或起止跨越两个章节时会抛错
        rangeCfi = makeRangeCfi(start.cfi, end.cfi)
        const range = await book.getRange(rangeCfi)
        text = range.toString().replace(/\s+/g, ' ').trim()
      } catch {
        // 退化方案:范围合成或取值失败(常见于可见区域跨越两个章节文档)时,
        // 直接读取当前渲染的第一个文档的全文作为近似正文——注意这通常会超过一屏的内容,
        // 只是为了不让上层拿到完全空白的正文。
        rangeCfi = ''
        // rendition.getContents() 在这版 epub.js 的类型声明里被错标成单个 Contents,
        // 运行时实际返回数组,这里只在本文件内断言,不改动对外类型。
        const contents = rendition.getContents() as unknown as Contents[]
        // 注:翻页动画进行中 getContents() 可能瞬时返回空数组,此时 body 取不到,text 会退化成空字符串。
        const body = contents[0]?.document?.body
        text = (body?.textContent ?? '').replace(/\s+/g, ' ').trim()
      }

      const href = String(start.href ?? '')
      const entry = toc.find((t) => t.href === href || t.href.split('#')[0] === href)
      const locations = book.locations as unknown as LocationsWithTotal
      const page = locationsReady ? locations.locationFromCfi(start.cfi) + 1 : 0
      const totalPages = locationsReady ? locations.total : 0

      return {
        text,
        startCfi: start.cfi,
        endCfi: end.cfi,
        rangeCfi,
        chapterHref: href,
        chapterLabel: entry ? entry.label : null,
        page,
        totalPages
      }
    },

    toc(): TocItem[] {
      return toc
    },

    currentCfi(): string | null {
      return rendition?.location?.start?.cfi ?? null
    },

    exportLocations(): string | null {
      if (!book || !locationsReady) return null
      return book.locations.save()
    },

    onRelocated(cb: () => void): () => void {
      listeners.push(cb)
      return () => {
        listeners = listeners.filter((x) => x !== cb)
      }
    },

    onKey(cb: (key: string) => void): () => void {
      keyListeners.push(cb)
      return () => {
        keyListeners = keyListeners.filter((x) => x !== cb)
      }
    },

    destroy(): void {
      // 先递增批次号,让任何还没跑完的 open() 延续(book.ready / navigation /
      // locations.generate 的 then)在恢复执行时立刻发现自己已经过期并退出,
      // 不再触碰马上要被 teardown 的 book/rendition。
      generation++
      teardown()
      listeners = []
      keyListeners = []
      window.removeEventListener('keydown', handleWindowKeydown)
    }
  }
}

export type { ReaderEngine } from './types'
