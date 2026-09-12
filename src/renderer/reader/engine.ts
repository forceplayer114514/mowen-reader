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

  return {
    async open(data: ArrayBuffer, opts: OpenOptions): Promise<void> {
      book = ePub(data)
      rendition = book.renderTo(container, {
        width: '100%',
        height: '100%',
        flow: 'paginated',
        spread: 'none',
        allowScriptedContent: false
      })
      rendition.themes.register('light', THEMES.light)
      rendition.themes.register('dark', THEMES.dark)
      rendition.themes.select(opts.theme)
      rendition.themes.fontSize(`${opts.fontSize}px`)

      await book.ready
      const nav = await book.loaded.navigation
      const items: TocItem[] = []
      flatToc(nav.toc, 0, items)
      toc = items

      if (opts.savedLocations) {
        book.locations.load(opts.savedLocations)
        locationsReady = true
      } else {
        void book.locations.generate(LOCATION_CHUNK).then(() => {
          locationsReady = true
          notify()
        })
      }

      rendition.on('relocated', notify)
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
      listeners = []
      rendition?.destroy()
      book?.destroy()
      rendition = null
      book = null
      toc = []
      locationsReady = false
    }
  }
}

export type { ReaderEngine } from './types'
