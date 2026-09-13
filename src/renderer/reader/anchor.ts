import { compareCfi } from './cfi'

/**
 * 挑出起点落在当前页文字范围内的对话。
 *
 * 页码随字号变化,CFI 不变,所以对话一律锚定到文字位置。判断规则是
 * "对话起点落在本页起止位置的闭区间内":一页可以装下过去的多个对话,
 * 横跨两页的旧对话归到它起点所在的那一页。
 *
 * 起点 CFI 损坏的对话被跳过而不是抛错——数据库里的历史数据可能来自
 * 旧版本或已被外部改动,一条坏记录不该让整页的历史都显示不出来。
 */
export function conversationsOnPage<T extends { startCfi: string }>(
  all: T[],
  pageStartCfi: string,
  pageEndCfi: string
): T[] {
  let lo: string
  let hi: string
  try {
    lo = compareCfi(pageStartCfi, pageEndCfi) <= 0 ? pageStartCfi : pageEndCfi
    hi = lo === pageStartCfi ? pageEndCfi : pageStartCfi
  } catch {
    return []
  }

  const usable: T[] = []
  for (const item of all) {
    try {
      if (compareCfi(item.startCfi, lo) >= 0 && compareCfi(item.startCfi, hi) <= 0) {
        usable.push(item)
      }
    } catch {
      // 起点坏掉的记录跳过
    }
  }
  return usable.sort((x, y) => compareCfi(x.startCfi, y.startCfi))
}
