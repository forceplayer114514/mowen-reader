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

  /**
   * 销毁当前的 rendition/book,清空容器,把状态复位到初始值。
   * 供 open()(重新打开前先清场)和 destroy()(退出阅读界面)共用。
   * 注意:这不是对外的 destroy() ——它不清空 listeners,重新 open 之后旧的
   * onRelocated 订阅者应当继续收到新书的通知。
   */
  function teardown(): void {
    rendition?.destroy()
    book?.destroy()
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
      if (epoch !== generation) return

      const nav = await nextBook.loaded.navigation
      if (epoch !== generation) return

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
          if (epoch !== generation) return
          locationsReady = true
          notify()
        })
      }

      nextRendition.on('relocated', notify)
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

    destroy(): void {
      // 先递增批次号,让任何还没跑完的 open() 延续(book.ready / navigation /
      // locations.generate 的 then)在恢复执行时立刻发现自己已经过期并退出,
      // 不再触碰马上要被 teardown 的 book/rendition。
      generation++
      teardown()
      listeners = []
    }
  }
}

export type { ReaderEngine } from './types'
