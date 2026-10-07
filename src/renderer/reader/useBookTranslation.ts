import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  joinSegmentTranslations,
  normalizeBookText,
  splitBookSegments,
  splitPdfParagraphs,
  visiblePageKey
} from '@shared/book-translation'
import type { VisibleRange } from './types'

interface Args {
  bookId: string
  enabled: boolean
  /** 用户在阅读页点了“开始翻译”后为 true；每本书打开后默认 false，需手动开启。 */
  started: boolean
  visible: VisibleRange | null
  isPdf: boolean
  /** 后台预取下一页段落（不翻页、不污染进度）；取不到返回 null。 */
  peekNextPageParagraphs?: (() => Promise<string[] | null>) | null
  /** 允许预取（正文就绪且未在恢复位置时为 true）。 */
  peekAllowed?: boolean
}

export interface BookTranslationPage {
  key: string
  text: string
  segmentCount: number
}

/** 翻页后等正文稳定再请求，避免快速连翻时为路过的页面调模型。 */
const SETTLE_MS = 350
/** 当前页就绪后，闲置这么久再预取下一页。 */
const PEEK_IDLE_MS = 600

/**
 * 整书 AI 翻译的内容分句调度（渲染层）。
 *
 * - 缓存单位是内容分句（与排版无关）：翻回已译页全命中 → 零 IPC、零模型调用；
 *   改字号只会让新露出的分句未命中，只翻译新增部分。
 * - 译文按段落组装（段落间空行分隔），与原文版式对应，不挤在一起。
 * - 一次只跑一个 ensure（并发 1），翻页过快时只保留最新一页排队，
 *   即“本页 + 下一页”的 2 页窗口，译完当前自动开始下一页，绝不全书翻译。
 * - 当前页就绪且闲置时，后台预取下一页段落并翻译（不翻页），翻页即秒显。
 */
export function useBookTranslation({ bookId, enabled, started, visible, isPdf, peekNextPageParagraphs, peekAllowed }: Args) {
  const [segCache, setSegCache] = useState<Map<string, string>>(new Map())
  const [cacheVersion, setCacheVersion] = useState(0)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [segCount, setSegCount] = useState(0)
  const genRef = useRef(0)
  const busyRef = useRef(false)
  const peekBusyRef = useRef(false)
  const pendingRef = useRef<{ key: string; segments: string[] } | null>(null)
  const cacheRef = useRef(segCache)
  cacheRef.current = segCache

  const active = enabled && started

  const putSegments = useCallback((translations: Map<string, string>) => {
    if (translations.size === 0) return
    setSegCache((prev) => {
      const next = new Map(prev)
      for (const [k, v] of translations) next.set(k, v)
      return next
    })
    setCacheVersion((v) => v + 1)
  }, [])

  // 切书/开关变化时清掉内存态，重新计数；在途请求回来后按代际丢弃。
  useEffect(() => {
    genRef.current++
    busyRef.current = false
    peekBusyRef.current = false
    pendingRef.current = null
    setSegCache(new Map())
    setCacheVersion((v) => v + 1)
    setBusyKey(null)
    setError(null)
    setSegCount(0)
    if (!bookId) return
    const gen = genRef.current
    void window.api.countBookSegments(bookId).then((n) => {
      if (gen === genRef.current) setSegCount(n)
    }).catch(() => {})
  }, [bookId, enabled])

  const pageKey = visible ? visiblePageKey(visible, isPdf) : null

  // 本页段落：引擎给结构化段落直接用，否则 PDF 按视觉行分组，其余回退整页文本。
  const pageParagraphs = useMemo<string[]>(() => {
    if (!visible) return []
    if (visible.paragraphs && visible.paragraphs.length > 0) {
      return visible.paragraphs.map((p) => normalizeBookText(p)).filter(Boolean)
    }
    const text = visible.text ?? ''
    if (!normalizeBookText(text)) return []
    if (isPdf) return splitPdfParagraphs(text)
    return [normalizeBookText(text)]
  }, [visible, isPdf])

  // 每段切分句（过滤空段）；扁平去重后即本页待保障的分句集合。
  const paraSegments = useMemo<string[][]>(
    () => pageParagraphs.map((para) => splitBookSegments(para)).filter((arr) => arr.length > 0),
    [pageParagraphs]
  )
  const flatUnique = useMemo<string[]>(
    () => [...new Set(paraSegments.flat().map((seg) => normalizeBookText(seg)).filter(Boolean))],
    [paraSegments]
  )

  // 当前页组装：分句全命中才展示（按段落拼回空行分隔），否则显示加载态。
  // 依赖 cacheVersion：后台预取填缓存后，已停留的页面能即时组装出来。
  const current: BookTranslationPage | null = useMemo(() => {
    if (!pageKey || paraSegments.length === 0) return null
    const cache = cacheRef.current
    const paras: string[] = []
    for (const segs of paraSegments) {
      const translated: string[] = []
      for (const seg of segs) {
        const hit = cache.get(normalizeBookText(seg))
        if (!hit) return null
        translated.push(hit)
      }
      paras.push(joinSegmentTranslations(translated))
    }
    return { key: pageKey, text: paras.join('\n\n'), segmentCount: flatUnique.length }
  }, [pageKey, paraSegments, flatUnique, cacheVersion])
  // 布尔形态供预取 effect 依赖：避免每次填缓存都因对象身份变化重复预取。
  const currentReady = current !== null

  const runEnsure = useCallback(async (key: string, segs: string[], gen: number, background: boolean): Promise<void> => {
    if (gen !== genRef.current) return
    busyRef.current = true
    if (!background) {
      setBusyKey(key)
      setError(null)
    }
    try {
      // 执行前复查内存：排队期间影子预取可能已填好，命中则连 IPC 都省了。
      const unique = [...new Set(segs.map(normalizeBookText).filter(Boolean))]
      const fresh = unique.filter((seg) => !cacheRef.current.has(seg))
      if (fresh.length === 0) return
      const { translations, translatedNow } = await window.api.ensureBookSegments(bookId, fresh)
      if (gen !== genRef.current) return
      const map = new Map<string, string>()
      fresh.forEach((seg, i) => {
        if (translations[i]) map.set(seg, translations[i])
      })
      putSegments(map)
      if (translatedNow > 0) {
        setSegCount((n) => n + translatedNow)
        // upsert 更新不增加行数，顺手按库校准一次。
        void window.api.countBookSegments(bookId).then((n) => {
          if (gen === genRef.current) setSegCount(n)
        }).catch(() => {})
      }
    } catch (e) {
      // 后台预取失败不打扰阅读：翻页到达时前台链路会重试并展示错误。
      if (!background && gen === genRef.current) {
        setError(e instanceof Error ? e.message : '翻译失败，请稍后重试')
      }
    } finally {
      if (gen !== genRef.current) return
      busyRef.current = false
      if (!background) setBusyKey((current) => (current === key ? null : current))
      // 译完当前自动开始下一页（排队的那一页，即翻页后的最新页）。
      const next = pendingRef.current
      pendingRef.current = null
      if (next && active) {
        void runEnsure(next.key, next.segments, gen, false)
      }
    }
  }, [active, bookId, putSegments])

  // 可见页变化：内存全命中即秒显；缺失则等正文稳定后 ensure；
  // 前台/后台任一在跑都把最新页排队（影子预取进行中时到达也不抢跑，等它落定后复用）。
  useEffect(() => {
    if (!active || !visible || !pageKey || flatUnique.length === 0) return
    const cache = cacheRef.current
    if (flatUnique.every((seg) => cache.has(seg))) return
    if (busyRef.current || peekBusyRef.current) {
      pendingRef.current = { key: pageKey, segments: flatUnique }
      return
    }
    const gen = genRef.current
    const timer = setTimeout(() => {
      if (gen !== genRef.current) return
      // 防抖期间用户可能已翻到缓存页：复查一次，命中则无需请求。
      const latest = cacheRef.current
      if (flatUnique.every((seg) => latest.has(seg))) return
      if (busyRef.current || peekBusyRef.current) {
        pendingRef.current = { key: pageKey, segments: flatUnique }
        return
      }
      void runEnsure(pageKey, flatUnique, gen, false)
    }, SETTLE_MS)
    return () => clearTimeout(timer)
  }, [active, visible, pageKey, flatUnique, runEnsure])

  // 后台预取：当前页已就绪且闲置时，取下一页段落并翻译（不翻页、不污染进度）。
  useEffect(() => {
    if (!active || !peekAllowed || !peekNextPageParagraphs || !currentReady) return
    const gen = genRef.current
    const timer = setTimeout(() => {
      if (gen !== genRef.current || busyRef.current || peekBusyRef.current) return
      peekBusyRef.current = true
      void (async () => {
        try {
          const paragraphs = await peekNextPageParagraphs()
          if (gen !== genRef.current || !paragraphs || paragraphs.length === 0) return
          const segs = [...new Set(
            paragraphs.map((p) => splitBookSegments(p)).flat().map((seg) => normalizeBookText(seg)).filter(Boolean)
          )]
          if (segs.length === 0) return
          const latest = cacheRef.current
          if (segs.every((seg) => latest.has(seg))) return
          await runEnsure(`peek:${Date.now()}`, segs, gen, true)
        } catch {
          // 预取失败静默：到达该页时前台链路会正常翻译。
        } finally {
          if (gen === genRef.current) peekBusyRef.current = false
        }
      })()
    }, PEEK_IDLE_MS)
    return () => clearTimeout(timer)
  }, [active, peekAllowed, peekNextPageParagraphs, currentReady, pageKey, runEnsure])

  return {
    current,
    currentKey: pageKey,
    busyKey,
    busy: busyKey !== null,
    error,
    segCount,
    segmentCount: flatUnique.length
  }
}
