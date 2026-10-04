import type { PdfOcrWord } from '../../shared/pdf-ocr-types'

interface TextRect { x: number; y: number; width: number; height: number }

function median(values: number[]): number {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
}

function sameLine(a: TextRect, b: TextRect): boolean {
  const overlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return overlap >= Math.min(a.height, b.height) * .5
    && Math.abs(a.y + a.height / 2 - b.y - b.height / 2) <= Math.max(a.height, b.height) * .6
}

/** Keep word order/text (and therefore CFIs), adjusting only invisible hit boxes. */
export function layoutPdfOcrWords(words: PdfOcrWord[], pageAspect = 1): PdfOcrWord[] {
  const result = words.map(word => ({ ...word }))
  const valid = words.map((word, index) => ({ word, index })).filter(({ word }) =>
    word.text && [word.x, word.y, word.width, word.height].every(Number.isFinite)
    && word.x >= 0 && word.y >= 0 && word.width > 0 && word.height > 0
    && word.x + word.width <= 1.000001 && word.y + word.height <= 1.000001)
  if (!valid.length) return result
  const typical = median(valid.map(({ word }) => word.height))
  const lines: typeof valid[] = []
  for (const entry of valid) {
    const line = lines.at(-1)
    if (line && sameLine(line[0].word, entry.word)) line.push(entry)
    else lines.push([entry])
  }
  for (const line of lines) {
    // Ink-tight punctuation and oversized recognizer boxes are not font metrics.
    const normal = line.filter(({ word }) => word.height >= typical * .6 && word.height <= typical * 1.5)
    const reference = normal.length ? normal : line
    const y = median(reference.map(({ word }) => word.y))
    const height = Math.min(1 - y, median(reference.map(({ word }) => word.height)))
    const ordered = [...line].sort((a, b) => a.word.x - b.word.x)
    ordered.forEach(({ word, index }, i) => {
      const next = ordered[i + 1]?.word
      let right = word.x + word.width
      // Fill ordinary inter-word gaps, but never bridge columns or separate labels.
      if (next && next.x > word.x && next.x - right <= height * pageAspect * 1.5) right = next.x
      result[index] = { ...word, y, height, width: right - word.x }
    })
  }
  return result
}

/** DOM ranges return both element and text rectangles; paint each line only once. */
export function mergePdfTextRects(rectangles: TextRect[]): TextRect[] {
  const rows: TextRect[][] = []
  const valid = rectangles.filter(r => [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0)
    .map(r => ({ ...r })).sort((a, b) => a.y - b.y || a.x - b.x)
  for (const rect of valid) {
    // ponytail: visible-page O(n²) row scan; bucket rows if large-page marking becomes slow.
    const row = rows.find(line => sameLine(line[0], rect))
    if (row) row.push(rect)
    else rows.push([rect])
  }
  return rows.flatMap(row => {
    const merged: TextRect[] = []
    for (const rect of row.sort((a, b) => a.x - b.x)) {
      const previous = merged.at(-1)
      if (previous && rect.x - previous.x - previous.width <= Math.max(previous.height, rect.height) * 1.5) {
        const right = Math.max(previous.x + previous.width, rect.x + rect.width)
        const bottom = Math.max(previous.y + previous.height, rect.y + rect.height)
        previous.y = Math.min(previous.y, rect.y)
        previous.width = right - previous.x; previous.height = bottom - previous.y
      } else merged.push({ ...rect })
    }
    return merged
  })
}
