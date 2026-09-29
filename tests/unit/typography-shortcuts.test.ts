import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import {
  ALLOWED_SETTING_KEYS,
  assertAllowedSettingKey
} from '../../src/main/db/settings'
import {
  DEFAULT_SHORTCUTS,
  DEFAULT_TYPOGRAPHY,
  normalizeFontFamily,
  normalizeLineHeight,
  normalizePageMargin,
  normalizeShortcutKey,
  normalizeTypography,
  validateShortcutMapping
} from '../../src/renderer/reader/types'

describe('排版预设归一化', () => {
  it('默认值:行距 1.75 / 标准边距 / 衬线', () => {
    expect(DEFAULT_TYPOGRAPHY).toEqual({ lineHeight: 1.75, margin: 'normal', fontFamily: 'serif' })
  })

  it('空输入全部退回默认,不抛错', () => {
    expect(normalizeTypography({})).toEqual(DEFAULT_TYPOGRAPHY)
    expect(normalizeTypography({ lineHeight: null, margin: undefined, fontFamily: 42 })).toEqual(
      DEFAULT_TYPOGRAPHY
    )
  })

  it('行距就近吸附到三档预设,脏字符串退回默认', () => {
    expect(normalizeLineHeight('1.5')).toBe(1.5)
    expect(normalizeLineHeight('2.0')).toBe(2.0)
    expect(normalizeLineHeight(1.8)).toBe(1.75)
    expect(normalizeLineHeight('特大号')).toBe(1.75)
  })

  it('页边距与字体只认预设名,大小写不敏感,其它退回默认', () => {
    expect(normalizePageMargin('wide')).toBe('wide')
    expect(normalizePageMargin('NARROW')).toBe('narrow')
    expect(normalizePageMargin('随缘')).toBe('normal')
    expect(normalizeFontFamily('sans')).toBe('sans')
    expect(normalizeFontFamily('Serif')).toBe('serif')
    expect(normalizeFontFamily('楷体')).toBe('serif')
  })
})

describe('快捷键映射', () => {
  it('默认两键不相同且不在保留键里', () => {
    expect(DEFAULT_SHORTCUTS.toggleToc).not.toBe(DEFAULT_SHORTCUTS.toggleBookmark)
    for (const key of Object.values(DEFAULT_SHORTCUTS)) {
      expect(validateShortcutMapping({ ...DEFAULT_SHORTCUTS, toggleToc: key === DEFAULT_SHORTCUTS.toggleToc ? key : 'z' })).toBeNull()
    }
  })

  it('大小写归一,非法输入退回各自默认值', () => {
    expect(normalizeShortcutKey('T', 't')).toBe('t')
    expect(normalizeShortcutKey('', 'b')).toBe('b')
    expect(normalizeShortcutKey('F1', 't')).toBe('t')
  })

  it('非单字母数字直接报错', () => {
    expect(validateShortcutMapping({ toggleToc: '', toggleBookmark: 'b' })).toMatch(/单个字母或数字/)
    expect(validateShortcutMapping({ toggleToc: 'F1', toggleBookmark: 'b' })).toMatch(/单个字母或数字/)
  })

  it('保留键(?)不可占用', () => {
    expect(validateShortcutMapping({ toggleToc: '?', toggleBookmark: 'b' })).toMatch(/占用/)
  })

  it('两项撞键报错', () => {
    expect(validateShortcutMapping({ toggleToc: 't', toggleBookmark: 'T' })).toMatch(/同一个键/)
  })
})

describe('设置键白名单新增排版与快捷键', () => {
  it('五个新键都在名单里且不重复', () => {
    for (const key of ['lineHeight', 'pageMargin', 'fontFamily', 'shortcutToc', 'shortcutBookmark']) {
      expect(() => assertAllowedSettingKey(key)).not.toThrow()
    }
    expect(new Set(ALLOWED_SETTING_KEYS).size).toBe(ALLOWED_SETTING_KEYS.length)
  })
})

/** setTypography 只测引擎与 epub.js 的交互:override、原生 gap、按锚点重落位。 */
const hub = vi.hoisted(() => ({ book: null as unknown }))

vi.mock('epubjs', () => ({ default: () => hub.book }))

let fakeWindow: EventTarget

function createTypoFakeEpub() {
  const overrides: [string, string][] = []
  const fonts: string[] = []
  const displayTargets: string[] = []
  const manager = { settings: { gap: 0 }, updateLayout: vi.fn() }

  const rendition = {
    location: {
      start: { cfi: 'epubcfi(/6/4!/4/2/2/1:0)', displayed: { page: 2, total: 8 } },
      end: { cfi: 'epubcfi(/6/4!/4/2/10/1:0)' }
    },
    spread: vi.fn(),
    themes: {
      register: (): void => {},
      select: (): void => {},
      fontSize: (): void => {},
      override: (name: string, value: string): void => {
        overrides.push([name, value])
      },
      font: (family: string): void => {
        fonts.push(family)
      }
    },
    q: { stop: (): void => {} },
    manager,
    annotations: {
      highlight: (): void => {},
      remove: (): void => {}
    },
    views: () => ({ length: 1 }),
    getContents: () => [
      {
        document: new EventTarget()
      }
    ],
    on: (): void => {},
    off: (): void => {},
    display: async (target?: string): Promise<void> => {
      if (target) displayTargets.push(target)
    },
    destroy: (): void => {}
  }

  hub.book = {
    ready: Promise.resolve(),
    loaded: { navigation: Promise.resolve({ toc: [] }) },
    packaging: { navPath: '', ncxPath: '' },
    spine: { each: (): void => {} },
    locations: {
      load: (): void => {},
      save: (): string => '[]',
      total: 9,
      length: () => 10,
      locationFromCfi: () => 9
    },
    getRange: async () => ({ toString: () => '正文内容' }),
    renderTo: (_container: unknown, options: { gap: number }) => {
      manager.settings.gap = options.gap
      return rendition
    },
    destroy: (): void => {}
  }

  return { overrides, fonts, manager, displayTargets }
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

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window')
})

describe('引擎 setTypography', () => {
  it('open() 即按传入预设写行距与字体,首屏不跳变', async () => {
    const f = createTypoFakeEpub()
    const { createEngine } = await import('../../src/renderer/reader/engine')
    const engine = createEngine(CONTAINER)
    await engine.open(new ArrayBuffer(0), {
      fontSize: 18,
      theme: 'light',
      savedLocations: 'x',
      typography: { lineHeight: 2.0, margin: 'wide', fontFamily: 'sans' }
    })
    expect(f.overrides).toContainEqual(['line-height', '2'])
    expect(f.fonts.length).toBe(1)
    expect(f.fonts[0]).toContain('PingFang')
    expect(f.manager.settings.gap).toBe(96)
    engine.destroy()
  })

  it('setTypography 按锚点重落位并更新原生页边距,不动其它状态', async () => {
    const f = createTypoFakeEpub()
    const { createEngine } = await import('../../src/renderer/reader/engine')
    const engine = createEngine(CONTAINER)
    await engine.open(new ArrayBuffer(0), { fontSize: 18, theme: 'light', savedLocations: 'x' })
    f.displayTargets.length = 0

    await engine.setTypography(
      { lineHeight: 1.5, margin: 'narrow', fontFamily: 'serif' },
      'epubcfi(/6/4!/4/2/2/1:0)'
    )

    expect(f.overrides).toContainEqual(['line-height', '1.5'])
    expect(f.fonts[0]).toContain('Songti')
    expect(f.manager.settings.gap).toBe(24)
    expect(f.manager.updateLayout).toHaveBeenCalled()
    // 锚点重落位:位置与进度原地保留,靠调用方 onRelocated 存盘,不在这里另写。
    expect(f.displayTargets).toEqual(['epubcfi(/6/4!/4/2/2/1:0)'])
    engine.destroy()
  })
})
