import { localDay } from '../shared/reading-stats'

/** 主进程计时，单调时钟防系统时间调整；只有短且连续的前台区间才计入。 */
export function createReadingTimer(save: (bookId: string, entries: Map<string, number>) => void,
  wallNow = Date.now, monotonicNow = () => performance.now()) {
  let bookId: string | null = null
  let active = false
  let previous = monotonicNow()
  const pending = new Map<string, Map<string, number>>()

  function tick(): void {
    const now = monotonicNow()
    const elapsed = Math.floor(now - previous)
    previous = now
    // ponytail: 1 秒采样，超过 5 秒的间断视为休眠/阻塞，不猜测离开期间是否在阅读。
    if (!bookId || !active || elapsed <= 0 || elapsed > 5000) return
    const entries = pending.get(bookId) ?? new Map<string, number>()
    pending.set(bookId, entries)
    const end = wallNow()
    let cursor = end - elapsed
    while (cursor < end) {
      const date = new Date(cursor)
      const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime()
      const next = Math.min(end, midnight)
      const day = localDay(date)
      entries.set(day, (entries.get(day) ?? 0) + next - cursor)
      cursor = next
    }
  }

  function flush(): void {
    tick()
    // 事务成功才移除待存数据；写盘失败时下次重试，不能重复计入已经存好的书。
    for (const [id, entries] of pending) {
      save(id, entries)
      pending.delete(id)
    }
  }

  return {
    tick, flush,
    setBook(id: string | null): void { tick(); bookId = id; flush() },
    setActive(value: boolean): void { tick(); active = value }
  }
}
