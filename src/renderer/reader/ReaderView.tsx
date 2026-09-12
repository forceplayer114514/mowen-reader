import { useCallback, useEffect, useRef, useState } from 'react'
import type { BookRecord } from '@shared/types'
import TocPanel from './TocPanel'
import { createEngine } from './engine'
import type { ReaderEngine, ThemeName, TocItem, VisibleRange } from './types'

const FONT_MIN = 14
const FONT_MAX = 28

interface Props {
  book: BookRecord
  onBack: () => void
}

export default function ReaderView({ book, onBack }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<ReaderEngine | null>(null)
  const [visible, setVisible] = useState<VisibleRange | null>(null)
  const [toc, setToc] = useState<TocItem[]>([])
  const [showToc, setShowToc] = useState(false)
  const [fontSize, setFontSize] = useState(18)
  const [theme, setTheme] = useState<ThemeName>('light')
  const [error, setError] = useState<string | null>(null)

  // 开书:读设置 → 读文件 → 渲染 → 跳到上次位置
  useEffect(() => {
    let cancelled = false
    let engine: ReaderEngine | null = null
    let unsubscribeRelocated: (() => void) | null = null
    let unsubscribeKey: (() => void) | null = null

    async function boot(): Promise<void> {
      if (!hostRef.current) return
      try {
        const savedFont = Number((await window.api.getSetting('fontSize')) ?? 18)
        const savedTheme = ((await window.api.getSetting('theme')) ?? 'light') as ThemeName
        const savedLocations = await window.api.getLocations(book.id)
        const data = await window.api.readBookFile(book.id)
        if (cancelled) return

        engine = createEngine(hostRef.current)
        engineRef.current = engine
        setFontSize(Number.isFinite(savedFont) ? savedFont : 18)
        setTheme(savedTheme)
        document.documentElement.dataset.theme = savedTheme

        // 位置索引首次生成完要落盘,下次开书省去重算。engine 在生成完成时和每次翻页时
        // 都会触发 onRelocated,这里复用同一个回调:exportLocations() 在索引还没
        // 就绪时返回 null,一旦第一次拿到非 null 值就存一次,之后不再重复写。
        // 必须在 open() 之前完成订阅:locations.generate() 是 open() 内部发起的,
        // 小书可能在 open()/display() 都还没返回的时候就生成完毕并触发一次 onRelocated,
        // 注册晚了就会错过这次通知,索引要等到下一次真正翻页才会落盘。engine.destroy()/
        // 重新 open() 都不会清空 onRelocated 的订阅列表(teardown() 特意保留它),
        // 所以提前订阅是安全的。
        let locationsSaved = savedLocations !== null
        unsubscribeRelocated = engine.onRelocated(() => {
          void engine!.getVisible().then((v) => {
            if (!cancelled) setVisible(v)
          })
          const cfi = engine!.currentCfi()
          if (cfi) void window.api.saveProgress(book.id, cfi)

          if (!locationsSaved) {
            const json = engine!.exportLocations()
            if (json) {
              locationsSaved = true
              void window.api.saveLocations(book.id, json)
            }
          }
        })

        unsubscribeKey = engine.onKey((key) => {
          if (key === 'ArrowRight' || key === 'PageDown') void engineRef.current?.next()
          else if (key === 'ArrowLeft' || key === 'PageUp') void engineRef.current?.prev()
        })

        await engine.open(data, {
          fontSize: Number.isFinite(savedFont) ? savedFont : 18,
          theme: savedTheme,
          savedLocations
        })
        // open() 期间 cancelled 可能已经变 true(视图在大书加载完之前就被卸载了):
        // 不检查的话下面 setToc()/display() 会在已销毁的 engine 上继续跑,
        // display() 还会因为 cleanup 已经 destroy() 过 engine 而抛错。
        if (cancelled) return

        setToc(engine.toc())
        await engine.display(book.lastReadCfi ?? undefined)
        if (cancelled) return

        // open()/display() 期间位置索引可能已经在 onRelocated 订阅注册之后、
        // display() 返回之前的某次 relocated 通知里生成完成并存过了;但也可能那次
        // 通知发生在其他时序下没被接住,这里主动查一次兜底。locationsSaved 已经为
        // true 时 exportLocations() 的结果会被直接丢弃,不会重复写入。
        if (!locationsSaved) {
          const json = engine.exportLocations()
          if (json) {
            locationsSaved = true
            void window.api.saveLocations(book.id, json)
          }
        }

        const v = await engine.getVisible()
        if (cancelled) return
        setVisible(v)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : '这本书打不开')
      }
    }

    void boot()
    return () => {
      cancelled = true
      unsubscribeRelocated?.()
      unsubscribeKey?.()
      engine?.destroy()
      engineRef.current = null
    }
  }, [book])

  const next = useCallback(() => void engineRef.current?.next(), [])
  const prev = useCallback(() => void engineRef.current?.prev(), [])

  // 按键翻页现在完全由 engine.onKey 驱动(见上面 boot effect 里的订阅):它同时接住
  // 外层 window 和书内容 iframe 文档里的 keydown,这里不再需要自己挂 window 监听器。

  const changeFont = useCallback((delta: number) => {
    setFontSize((old) => {
      const size = Math.min(FONT_MAX, Math.max(FONT_MIN, old + delta))
      engineRef.current?.setFontSize(size)
      void window.api.setSetting('fontSize', String(size))
      return size
    })
  }, [])

  const toggleTheme = useCallback(() => {
    setTheme((old) => {
      const nextTheme: ThemeName = old === 'light' ? 'dark' : 'light'
      engineRef.current?.setTheme(nextTheme)
      document.documentElement.dataset.theme = nextTheme
      void window.api.setSetting('theme', nextTheme)
      return nextTheme
    })
  }, [])

  const jump = useCallback((href: string) => {
    setShowToc(false)
    void engineRef.current?.display(href)
  }, [])

  if (error) {
    return (
      <div className="reader__error">
        <p>{error}</p>
        <button onClick={onBack}>← 回到书架</button>
      </div>
    )
  }

  return (
    <div className="reader">
      <header className="reader__bar">
        <button onClick={onBack}>← 书架</button>
        <button onClick={() => setShowToc((v) => !v)} data-testid="toggle-toc">
          目录
        </button>
        <span className="reader__title">{book.title}</span>
        <span className="reader__spacer" />
        <button onClick={() => changeFont(-2)} aria-label="缩小字号">
          A−
        </button>
        <span className="reader__fontsize" data-testid="font-size">
          {fontSize}
        </span>
        <button onClick={() => changeFont(2)} aria-label="放大字号">
          A+
        </button>
        <button onClick={toggleTheme}>{theme === 'light' ? '夜间' : '日间'}</button>
      </header>

      <div className="reader__body">
        {showToc && (
          <TocPanel
            items={toc}
            currentHref={visible?.chapterHref ?? ''}
            onJump={jump}
            onClose={() => setShowToc(false)}
          />
        )}
        <button className="reader__nav reader__nav--prev" onClick={prev} aria-label="上一页">
          ‹
        </button>
        <div className="reader__page" ref={hostRef} data-testid="reader-page" />
        <button className="reader__nav reader__nav--next" onClick={next} aria-label="下一页">
          ›
        </button>
      </div>

      <footer className="reader__foot" data-testid="reader-foot">
        <span>{visible?.chapterLabel ?? ''}</span>
        <span data-testid="page-indicator">
          {visible && visible.totalPages > 0
            ? `第 ${visible.page} / ${visible.totalPages} 页`
            : '正在计算页码…'}
        </span>
      </footer>
    </div>
  )
}
