import { useCallback, useEffect, useRef, useState } from 'react'
import type { BookRecord } from '@shared/types'
import TocPanel from './TocPanel'
import { createEngine } from './engine'
import type { ReaderEngine, ThemeName, TocItem, VisibleRange } from './types'

const FONT_MIN = 14
const FONT_MAX = 28
/** 恢复阅读位置时,校验落点最多重试这么多次(见 boot() 里的用法和注释)。 */
const MAX_POSITION_VERIFY_ATTEMPTS = 3
/** 打开书之后一直拿不到一次成功的 getVisible(),等这么久就判定书是真的读不出来。 */
const VISIBLE_STUCK_TIMEOUT_MS = 5000

/** 等下一帧再继续——给 epub.js 一点时间把刚创建窗口时还没定型的排版尺寸重新测量一遍。 */
function waitForFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

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
    let stuckTimer: ReturnType<typeof setTimeout> | null = null
    let hasVisible = false

    function clearStuckTimer(): void {
      if (stuckTimer !== null) {
        clearTimeout(stuckTimer)
        stuckTimer = null
      }
    }

    // 拿到一次成功的 getVisible() 结果统一走这里:标记"已经成功过"并撤掉兜底的
    // 超时提示,避免一本能正常读的书只是稍微慢一点,就被误判成"打不开"。
    function handleVisible(v: VisibleRange): void {
      hasVisible = true
      clearStuckTimer()
      if (!cancelled) setVisible(v)
    }

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
            handleVisible(v)
          }).catch(() => {
            // 书还没有打开时 getVisible() 会抛错。display() 运行前回调就可能被触发，
            // 此时没有任何内容可见，静默处理这个失败即可——如果书其实读不出来，
            // 下面的 stuckTimer 兜底会在几秒后把这个情况变成界面上的错误提示。
          })
          const cfi = engine!.currentCfi()
          if (cfi) {
            // 存阅读进度失败先静默处理:偶发失败不值得打断阅读体验,下次翻页/
            // relocate 触发时会用最新位置重试,不会残留未处理的 rejection。
            void window.api.saveProgress(book.id, cfi).catch(() => {})
          }

          if (!locationsSaved) {
            const json = engine!.exportLocations()
            if (json) {
              locationsSaved = true
              // 位置索引写入失败同样静默:损失的只是下次开书时重新计算索引的时间,
              // 不影响当前阅读,但仍要接住 rejection,不能变成未处理的 promise 拒绝。
              void window.api.saveLocations(book.id, json).catch(() => {})
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
        if (cancelled) return

        // 打开成功之后,如果 VISIBLE_STUCK_TIMEOUT_MS 之内一直等不到一次成功的
        // getVisible(),说明这本书是真的读不出来——跟下面 display() 刚返回时
        // 那种正常的排版空档不是一回事(那种情况几十毫秒内就会被 onRelocated
        // 补上)。这里用一个兜底计时器把这种真正的失败反映到界面上,而不是让
        // 阅读界面一直空白,连页码和错误提示都没有。一旦 handleVisible() 被
        // 调用过一次(不管是下面这次直接调用还是 onRelocated 里的那次),
        // 计时器会被清掉,不会误报。
        stuckTimer = setTimeout(() => {
          if (!cancelled && !hasVisible) {
            setError('书本内容长时间无法显示,可能是文件已损坏')
          }
        }, VISIBLE_STUCK_TIMEOUT_MS)

        setToc(engine.toc())
        await engine.display(book.lastReadCfi ?? undefined)
        if (cancelled) return

        // 恢复上次读到的位置时,这次 display() 有时会落在比保存的位置更靠前的地方
        // (亲测偏差正好是几个物理翻页)。原因是 epub.js 把 CFI 换算成滚动偏移量靠的
        // 是 manager.moveTo() 里的 view.locationOf()/this.layout.delta(见
        // node_modules/epubjs/src/managers/default/index.js 的 display()/moveTo()),
        // 这次调用发生在这本书在这个全新窗口里第一次真正跑完排版之前,量出来的列宽
        // /偏移还没定型,算出的滚动位置自然是错的。这个时机窗口有多长跟机器快慢有关,
        // 不能靠"反正再调一次 display() 时机就够晚了"这种运气——机器足够快或足够慢,
        // 两次调用都可能落进同一个还没定型的窗口。这里改成校验而不是假设:display()
        // 之后用 currentCfi() 回读引擎实际落到了哪里,跟目标位置比对,不一致就等一帧
        // (给排版一点时间定型)再重新 display() 一次,最多重试 MAX_POSITION_VERIFY_ATTEMPTS
        // 次;还是不一致就安静放弃,不能无限重试卡住阅读。首次打开新书(没有
        // lastReadCfi)不存在这个问题,不需要这段校验。
        if (book.lastReadCfi) {
          const target = book.lastReadCfi
          for (
            let attempt = 0;
            attempt < MAX_POSITION_VERIFY_ATTEMPTS && engine.currentCfi() !== target;
            attempt++
          ) {
            await waitForFrame()
            if (cancelled) return
            await engine.display(target)
            if (cancelled) return
          }
        }

        // open()/display() 期间位置索引可能已经在 onRelocated 订阅注册之后、
        // display() 返回之前的某次 relocated 通知里生成完成并存过了;但也可能那次
        // 通知发生在其他时序下没被接住,这里主动查一次兜底。locationsSaved 已经为
        // true 时 exportLocations() 的结果会被直接丢弃,不会重复写入。
        if (!locationsSaved) {
          const json = engine.exportLocations()
          if (json) {
            locationsSaved = true
            void window.api.saveLocations(book.id, json).catch(() => {})
          }
        }

        // epub.js 的 Rendition._display() 会在 manager.render() 完成、也就是我们的
        // display() 这个 await 返回的那一刻就 resolve,但它自己紧接着触发的
        // reportLocation() 是另外排进内部队列、靠 requestAnimationFrame 驱动的异步步骤
        // (见 node_modules/epubjs/src/rendition.js reportLocation()),要再等一帧才会
        // 真正把 rendition.location 填上。也就是说 display() 刚返回的这一刻,
        // rendition.location 几乎总是还是 undefined,这里立刻调用 getVisible() 十有
        // 八九会撞上这个空档而抛"书还没打开"。跟上面 onRelocated 回调里的同一个
        // getVisible() 调用一样处理:失败就静默跳过,不当作书打不开的致命错误——
        // 上面的 onRelocated 订阅马上会等到这次 display() 真正触发的 relocated 事件,
        // 到时候会用同一个 getVisible() 正常拿到结果并 setVisible()。
        // 如果在这里把这次失败当成致命错误(之前的写法),会把还没出错的阅读界面
        // 整页替换成"书还没打开"的错误提示,而且后面 visible 一旦被 onRelocated
        // 补上,这个 error 状态也不会被清掉,footer 里会一直挂着这条误报。
        try {
          const v = await engine.getVisible()
          handleVisible(v)
        } catch {
          // 见上面注释:这是 display() 刚返回、relocated 事件还没来得及触发的
          // 正常空档,不是书打不开——如果确实打不开,上面的 stuckTimer 兜底
          // 会在超时后把它变成界面上的错误提示,这里不需要再处理一次。
        }
      } catch (e) {
        clearStuckTimer()
        if (!cancelled) setError(e instanceof Error ? e.message : '这本书打不开')
      }
    }

    void boot()
    return () => {
      cancelled = true
      clearStuckTimer()
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
      // 乐观更新了字号状态,写盘失败要在页脚提示,否则界面和存储的值会不一致却毫无提示。
      setError(null)
      window.api.setSetting('fontSize', String(size)).catch(() => {
        setError('字号没有保存,下次打开可能会恢复默认')
      })
      return size
    })
  }, [])

  const toggleTheme = useCallback(() => {
    setTheme((old) => {
      const nextTheme: ThemeName = old === 'light' ? 'dark' : 'light'
      engineRef.current?.setTheme(nextTheme)
      document.documentElement.dataset.theme = nextTheme
      // 同上:主题也是乐观更新,写盘失败要在页脚提示。
      setError(null)
      window.api.setSetting('theme', nextTheme).catch(() => {
        setError('主题没有保存,下次打开可能会恢复默认')
      })
      return nextTheme
    })
  }, [])

  const jump = useCallback((href: string) => {
    setShowToc(false)
    void engineRef.current?.display(href)
  }, [])

  // error 同时承载两类情况:书打不开(致命,此时 visible 还没被设置过,整页替换成
  // 错误提示)和设置写盘失败(非致命,阅读已经在正常进行,只在页脚提一句,不打断阅读)。
  // error && !visible 的判断依赖:当用户返回书架时,此组件会完全卸载，下一次打开书
  // 时是一个全新的实例,visible 总是从未设置状态开始。如果组件被复用于不同的书，这个
  // 假设就会被破坏，导致设置错误误显示为整页错误。
  if (error && !visible) {
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
        {error && visible && (
          <span className="reader__foot-error" data-testid="settings-error">
            {error}
          </span>
        )}
      </footer>
    </div>
  )
}
