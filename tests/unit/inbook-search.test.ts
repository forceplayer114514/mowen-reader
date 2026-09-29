import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_SEARCH_RESULTS,
  cleanSearchExcerpt,
  normalizeSearchQuery,
  pdfExcerptForMatch,
  searchPdfPages
} from '../../src/renderer/reader/types'

/**
 * 书内全文搜索(feature #2)的 focused 测试。
 *
 * 纯匹配/摘要逻辑直接测 types.ts 里的纯函数,不启动 epub.js 与 pdfjs;
 * EPUB 引擎的逐章 search/find 编排用替身 spine 测"引擎对章节说了什么话";
 * PDF 引擎的 search() 本体(逐页 getTextContent)与真实 pdfjs 强绑定,
 * 留给构建 + 真机验收,见文件末尾的注释。
 */

describe('normalizeSearchQuery', () => {
  it('去前后空白,空查询保持为空', () => {
    expect(normalizeSearchQuery('  你好  ')).toBe('你好')
    expect(normalizeSearchQuery('   ')).toBe('')
    expect(normalizeSearchQuery('')).toBe('')
  })

  it('超长查询截断,避免病态输入卡死逐章查找', () => {
    expect(normalizeSearchQuery('a'.repeat(500))).toHaveLength(200)
  })

  it('不改大小写:大小写不敏感由匹配侧统一转小写完成', () => {
    expect(normalizeSearchQuery('Hello')).toBe('Hello')
  })
})

describe('cleanSearchExcerpt', () => {
  it('空白归一化', () => {
    expect(cleanSearchExcerpt('  hello   \n  world  ')).toBe('hello world')
  })

  it('超长截断并补省略号', () => {
    const out = cleanSearchExcerpt('a'.repeat(500), 100)
    expect(out).toHaveLength(101)
    expect(out.endsWith('…')).toBe(true)
  })

  it('不插入任何标记:摘要只走文本节点渲染', () => {
    expect(cleanSearchExcerpt('<script>alert(1)</script>')).toBe('<script>alert(1)</script>')
  })
})

describe('searchPdfPages', () => {
  it('空查询返回空数组,不掃任何页', () => {
    expect(searchPdfPages([{ page: 1, text: 'hello' }], '   ')).toEqual([])
  })

  it('大小写不敏感,摘要保留原文大小写', () => {
    const hits = searchPdfPages([{ page: 2, text: 'Hello World' }], 'hello')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ cfiRange: 'pdf-page-2', page: 2, label: '第 2 页' })
    expect(hits[0].excerpt).toContain('Hello')
  })

  it('同一页的多次命中全部返回,长文本摘要前后截断', () => {
    const text = `${'x'.repeat(200)}key${'y'.repeat(200)}key${'z'.repeat(200)}`
    const hits = searchPdfPages([{ page: 1, text }], 'key')
    expect(hits).toHaveLength(2)
    expect(hits[0].excerpt.startsWith('…')).toBe(true)
    expect(hits[0].excerpt.endsWith('…')).toBe(true)
    expect(hits[0].excerpt).toContain('key')
  })

  it('短文本命中不加省略号', () => {
    const hits = searchPdfPages([{ page: 1, text: 'ab key cd' }], 'key')
    expect(hits[0].excerpt).toBe('ab key cd')
  })

  it('跨页按页码顺序返回,命中上限生效', () => {
    const pages = [
      { page: 1, text: 'alpha' },
      { page: 2, text: 'alpha alpha' },
      { page: 3, text: 'nothing here' }
    ]
    expect(searchPdfPages(pages, 'alpha')).toHaveLength(3)
    expect(searchPdfPages(pages, 'alpha', (p) => `第 ${p} 页`, 2)).toHaveLength(2)
  })

  it('label 回调用于目录标题,缺省回退到"第 N 页"', () => {
    const hits = searchPdfPages([{ page: 5, text: 't target t' }], 'target', () => '前言')
    expect(hits[0].label).toBe('前言')
    expect(hits[0].cfiRange).toBe('pdf-page-5')
  })

  it('单页重复词不会淹没整本结果(上限可配)', () => {
    const text = Array(100).fill('hit').join(' ')
    const hits = searchPdfPages([{ page: 1, text }, { page: 2, text: 'hit' }], 'hit', (p) => `第 ${p} 页`, MAX_SEARCH_RESULTS)
    expect(hits.length).toBeLessThanOrEqual(MAX_SEARCH_RESULTS)
    // 第二页的命中仍然在:上限是整本范围的,不是"第一页塞满就结束"。
    expect(hits.some((h) => h.page === 2)).toBe(true)
  })
})

describe('pdfExcerptForMatch', () => {
  it('命中在开头时只有后缀省略号', () => {
    const out = pdfExcerptForMatch(`key${'z'.repeat(200)}`, 0, 3)
    expect(out.startsWith('…')).toBe(false)
    expect(out.endsWith('…')).toBe(true)
  })
})

/**
 * EPUB 引擎 search() 的编排测试:章节替身只负责如实记账,
 * 断言引擎按 load → search/find → unload 的顺序逐章走,
 * 损坏的单章跳过而不是整本报错。
 */
const hub = vi.hoisted(() => ({ book: null as unknown }))

vi.mock('epubjs', () => ({ default: () => hub.book }))

let fakeWindow: EventTarget

interface FakeSection {
  href: string
  unloaded: boolean
  loadCalls: number
  load: (request: (path: string) => Promise<unknown>) => Promise<unknown>
  unload: () => void
  search?: (query: string) => { cfi: string; excerpt: string }[]
  find?: (query: string) => { cfi: string; excerpt: string }[]
}

function section(
  href: string,
  behavior: Partial<Pick<FakeSection, 'search' | 'find' | 'load'>> = {}
): FakeSection {
  const s: FakeSection = {
    href,
    unloaded: false,
    loadCalls: 0,
    load: behavior.load ?? (async () => ({})),
    unload: () => { s.unloaded = true },
    ...behavior
  }
  const origLoad = s.load
  s.load = async (request) => {
    s.loadCalls++
    return origLoad(request)
  }
  return s
}

function createFakeEpubWithSections(sections: FakeSection[]): { displayTargets: string[] } {
  const displayTargets: string[] = []
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>()
  const rendition = {
    location: {
      start: { cfi: 'epubcfi(/6/4!/4/2/2/1:0)', displayed: { page: 1, total: 1 } },
      end: { cfi: 'epubcfi(/6/4!/4/2/10/1:0)' }
    },
    spread: vi.fn(),
    next: vi.fn(async (): Promise<void> => {}),
    themes: { register: () => {}, select: () => {}, fontSize: () => {} },
    q: { stop: () => {} },
    annotations: {
      highlight: () => {},
      remove: () => {}
    },
    views: () => ({ length: 1 }),
    getContents: () => [],
    on(type: string, cb: (...args: unknown[]) => void): void {
      const set = handlers.get(type) ?? new Set()
      set.add(cb)
      handlers.set(type, set)
    },
    off(type: string, cb: (...args: unknown[]) => void): void {
      handlers.get(type)?.delete(cb)
    },
    display: async (target?: string): Promise<void> => { if (target) displayTargets.push(target) },
    destroy: (): void => {}
  }
  hub.book = {
    ready: Promise.resolve(),
    loaded: { navigation: Promise.resolve({ toc: [] }) },
    packaging: { navPath: '', ncxPath: '' },
    load: async () => ({}),
    spine: {
      length: sections.length,
      get: (i: number) => sections[i],
      each: (cb: (s: FakeSection) => void) => sections.forEach(cb)
    },
    locations: {
      load: (): void => {},
      save: (): string => '[]',
      total: 0,
      length: () => 1,
      locationFromCfi: () => 0
    },
    getRange: async () => ({ toString: () => '' }),
    renderTo: () => rendition,
    destroy: (): void => {}
  }
  return { displayTargets }
}

const CONTAINER = { replaceChildren: (): void => {} } as unknown as HTMLElement

beforeEach(() => {
  fakeWindow = new EventTarget()
  Object.defineProperty(globalThis, 'window', {
    value: fakeWindow,
    configurable: true,
    writable: true
  })
})

describe('epub engine.search', () => {
  it('空查询直接返回空数组,一个章节也不 load', async () => {
    const s0 = section('ch0.xhtml', { search: () => [{ cfi: 'cfi-x', excerpt: 'x' }] })
    createFakeEpubWithSections([s0])
    const { createEngine } = await import('../../src/renderer/reader/engine')
    const engine = createEngine(CONTAINER)
    await engine.open(new ArrayBuffer(0), { fontSize: 18, theme: 'light', savedLocations: 'x' })
    expect(await engine.search('   ')).toEqual([])
    expect(s0.loadCalls).toBe(0)
    engine.destroy()
  })

  it('逐章 search,命中带精确 CFI 与摘要,读完即 unload', async () => {
    const s0 = section('ch0.xhtml', {
      search: (q) => (q === 'hello' ? [{ cfi: 'epubcfi(/6/4!/4/2/1:0)', excerpt: '  hello   world  ' }] : [])
    })
    const s1 = section('ch1.xhtml', { search: () => [] })
    createFakeEpubWithSections([s0, s1])
    const { createEngine } = await import('../../src/renderer/reader/engine')
    const engine = createEngine(CONTAINER)
    await engine.open(new ArrayBuffer(0), { fontSize: 18, theme: 'light', savedLocations: 'x' })
    const hits = await engine.search('hello')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({
      cfiRange: 'epubcfi(/6/4!/4/2/1:0)',
      excerpt: 'hello world',
      label: 'ch0.xhtml'
    })
    expect(s0.loadCalls).toBe(1)
    expect(s1.loadCalls).toBe(1)
    expect(s0.unloaded).toBe(true)
    expect(s1.unloaded).toBe(true)
    engine.destroy()
  })

  it('search 抛错时用 find 兜底,单章 load 失败跳过该章', async () => {
    const s0 = section('ch0.xhtml', {
      search: () => { throw new Error('no TreeWalker') },
      find: () => [{ cfi: 'cfi-find-1', excerpt: 'found by find' }]
    })
    const s1 = section('ch1.xhtml', {
      load: async () => { throw new Error('broken chapter') },
      search: () => [{ cfi: 'cfi-never', excerpt: 'never' }]
    })
    createFakeEpubWithSections([s0, s1])
    const { createEngine } = await import('../../src/renderer/reader/engine')
    const engine = createEngine(CONTAINER)
    await engine.open(new ArrayBuffer(0), { fontSize: 18, theme: 'light', savedLocations: 'x' })
    const hits = await engine.search('found')
    // 坏掉的那一章被跳过,整本搜索不断;find 兜底的命中正常返回。
    expect(hits.map((h) => h.cfiRange)).toEqual(['cfi-find-1'])
    engine.destroy()
  })

  it('search 与 find 重复的 CFI 去重', async () => {
    const dup = { cfi: 'cfi-same', excerpt: 'same' }
    const s0 = section('ch0.xhtml', {
      search: () => [dup],
      find: () => [dup, { cfi: 'cfi-other', excerpt: 'other' }]
    })
    createFakeEpubWithSections([s0])
    const { createEngine } = await import('../../src/renderer/reader/engine')
    const engine = createEngine(CONTAINER)
    await engine.open(new ArrayBuffer(0), { fontSize: 18, theme: 'light', savedLocations: 'x' })
    const hits = await engine.search('same')
    expect(hits.map((h) => h.cfiRange)).toEqual(['cfi-same', 'cfi-other'])
    engine.destroy()
  })
})
