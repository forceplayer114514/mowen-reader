import { useCallback, useEffect, useRef, useState } from 'react'
import type { BookTranslationRecord } from '@shared/book-translation'
import { bookTranslationKey } from '@shared/book-translation'
import type { VisibleRange } from './types'

interface Args {
  bookId: string
  enabled: boolean
  /** 用户在阅读页点了“开始翻译”后为 true；每本书打开后默认 false，需手动开启。 */
  started: boolean
  visible: VisibleRange | null
  isPdf: boolean
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 整书 AI 翻译的逐页增量调度（渲染层）。
 *
 * - 默认不翻译；用户点“开始翻译”后 `started` 置 true，才开始为当前页请求译文。
 * - 一次只译一页（并发 1），翻页过快时只保留最新的一页排队，即“本页 + 下一页”
 *   的 2 页窗口，译完当前自动开始下一页，绝不一次性全书翻译。
 * - 缓存优先：先读本地缓存，命中且原文一致直接展示，不再计费；未命中才走
 *   `translateBookPage`（主进程内同样先查缓存，命中不调模型）。
 * - 缓存永久保留：关闭/禁用/重开均不删除，重开后命中即秒显。
 */
export function useBookTranslation({ bookId, enabled, started, visible, isPdf }: Args) {
  const [cache, setCache] = useState<Map<string, BookTranslationRecord>>(new Map())
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [count, setCount] = useState(0)
  const genRef = useRef(0)
  const busyRef = useRef(false)
  const pendingRef = useRef<{ pageKey: string; sourceText: string } | null>(null)
  const cacheRef = useRef(cache)
  cacheRef.current = cache
  const visibleRef = useRef(visible)
  visibleRef.current = visible

  const active = enabled && started

  const putCache = useCallback((record: BookTranslationRecord) => {
    setCache((prev) => {
      const next = new Map(prev)
      next.set(record.pageKey, record)
      return next
    })
  }, [])

  // 切书/开关变化时清掉内存态，重新计数；在途请求回来后按代际丢弃。
  useEffect(() => {
    genRef.current++
    busyRef.current = false
    pendingRef.current = null
    setCache(new Map())
    setBusyKey(null)
    setError(null)
    setCount(0)
    if (!bookId) return
    const gen = genRef.current
    void window.api.countBookTranslations(bookId).then((n) => {
      if (gen === genRef.current) setCount(n)
    }).catch(() => {})
  }, [bookId, enabled])

  const runOne = useCallback(async (pageKey: string, sourceText: string, gen: number): Promise<void> => {
    if (gen !== genRef.current) return
    busyRef.current = true
    setBusyKey(pageKey)
    setError(null)
    try {
      const text = sourceText.trim()
      if (!text) {
        if (gen === genRef.current) setError('本页没有可翻译的文字')
        return
      }
      // 缓存优先：命中且原文一致直接用，不调模型。
      try {
        const hit = await window.api.getBookTranslation(bookId, pageKey)
        if (gen !== genRef.current) return
        if (hit && normalize(hit.sourceText) === normalize(text)) {
          putCache(hit)
          return
        }
      } catch {
        // 读缓存失败不阻塞翻译，走正常翻译路径。
      }
      if (gen !== genRef.current) return
      const saved = await window.api.translateBookPage(bookId, pageKey, text)
      if (gen !== genRef.current) return
      putCache(saved)
      setCount((n) => n + 1)
      // 计数以库为准（upsert 更新时不应重复累加），顺手校准一次。
      void window.api.countBookTranslations(bookId).then((n) => {
        if (gen === genRef.current) setCount(n)
      }).catch(() => {})
    } catch (e) {
      if (gen === genRef.current) setError(e instanceof Error ? e.message : '翻译失败，请稍后重试')
    } finally {
      if (gen !== genRef.current) return
      busyRef.current = false
      setBusyKey((current) => (current === pageKey ? null : current))
      // 译完当前自动开始下一页（排队的那一页，即翻页后的最新页）。
      const next = pendingRef.current
      pendingRef.current = null
      if (next && active) {
        // 排队的是翻页后的最新页；若用户又翻走了，visible 效应会重新排队，这里只跑一次。
        void runOne(next.pageKey, next.sourceText, gen)
      }
    }
  }, [active, bookId, putCache])

  // 可见页变化时确保当前页已翻译；在译中则把最新页排队（只保留一页，即下一页）。
  useEffect(() => {
    if (!active || !visible) return
    const sourceText = visible.text ?? ''
    if (!sourceText.trim()) return
    const pageKey = bookTranslationKey(visible, isPdf)
    const gen = genRef.current
    // 已有缓存且原文一致，无需请求。
    const hit = cacheRef.current.get(pageKey)
    if (hit && normalize(hit.sourceText) === normalize(sourceText)) return
    if (busyRef.current) {
      pendingRef.current = { pageKey, sourceText }
      return
    }
    void runOne(pageKey, sourceText, gen)
  }, [active, visible, isPdf, runOne])

  const currentKey = visible ? bookTranslationKey(visible, isPdf) : null
  const current = currentKey ? cache.get(currentKey) ?? null : null
  // 同一键命中但排版导致正文变化时，视为未命中（主进程会更新缓存），避免展示错位译文。
  const currentUsable =
    current && visible && normalize(current.sourceText) === normalize(visible.text ?? '') ? current : null

  return { current: currentUsable, currentKey, busyKey, busy: busyKey !== null, error, count, cache }
}
