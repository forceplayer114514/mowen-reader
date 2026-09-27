export interface ReadingStats {
  days: { day: string; milliseconds: number }[]
  books: { bookId: string; milliseconds: number; days: number; lastDay: string }[]
}

/** 不把未到末页的 99.x% 四舍五入成「已读完」。 */
export function readingPercent(progress = 0): number {
  return Number.isFinite(progress) ? Math.floor(Math.max(0, Math.min(1, progress)) * 100) : 0
}

export function localDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function formatReadingTime(milliseconds: number): string {
  if (milliseconds <= 0) return '0 分钟'
  if (milliseconds < 60_000) return '不到 1 分钟'
  const minutes = Math.floor(milliseconds / 60_000)
  if (minutes < 60) return `${minutes} 分钟`
  const rest = minutes % 60
  return `${Math.floor(minutes / 60)} 小时${rest ? ` ${rest} 分钟` : ''}`
}
