import { expect, it } from 'vitest'
import { layoutPdfOcrWords, mergePdfTextRects } from '../../src/renderer/reader/pdf-selection'

it('normalizes Chinese OCR ink boxes without changing text, order or cached geometry', () => {
  const words = [
    { text: '他', x: .1, y: .2, width: .02, height: .02 },
    { text: '们', x: .125, y: .201, width: .018, height: .019 },
    { text: '，', x: .15, y: .213, width: .003, height: .006 },
    { text: '达', x: .17, y: .196, width: .025, height: .037 },
    { text: '国家', x: .2, y: .201, width: .04, height: .019 },
    { text: '下一行', x: .1, y: .25, width: .1, height: .02 }
  ]
  const original = JSON.stringify(words)
  const layout = layoutPdfOcrWords(words, 1.5)
  expect(JSON.stringify(words)).toBe(original)
  expect(layout.map(w => w.text)).toEqual(words.map(w => w.text))
  expect(new Set(layout.slice(0, 5).map(w => w.y)).size).toBe(1)
  expect(new Set(layout.slice(0, 5).map(w => w.height)).size).toBe(1)
  for (let i = 0; i < 4; i++) expect(layout[i].x + layout[i].width).toBeCloseTo(layout[i + 1].x)
  expect(layout[5]).toEqual(words[5])
})

it('clamps overlapping OCR cells but preserves column gaps and invalid word indices', () => {
  const words = [
    { text: '度', x: .1, y: .2, width: .09, height: .02 },
    { text: '还是', x: .14, y: .2, width: .04, height: .02 },
    { text: '右栏', x: .7, y: .2, width: .04, height: .02 },
    { text: 'invalid', x: NaN, y: .2, width: .04, height: .02 }
  ]
  const layout = layoutPdfOcrWords(words)
  expect(layout[0].width).toBeCloseTo(.04)
  expect(layout[1].width).toBeCloseTo(words[1].width)
  expect(layout[3]).toEqual(words[3])
  expect(layoutPdfOcrWords([])).toEqual([])
})

it('paints duplicate range rectangles and short inter-word gaps once per line', () => {
  const rectangles = [
    { x: 10, y: 20, width: 20, height: 14 },
    { x: 10, y: 21, width: 20, height: 12 },
    { x: 32, y: 20, width: 25, height: 14 },
    { x: 60, y: 20, width: 10, height: 14 },
    { x: 10, y: 45, width: 40, height: 14 },
    { x: 200, y: 20, width: 30, height: 14 }
  ]
  const original = JSON.stringify(rectangles)
  expect(mergePdfTextRects(rectangles)).toEqual([
    { x: 10, y: 20, width: 60, height: 14 },
    { x: 200, y: 20, width: 30, height: 14 },
    { x: 10, y: 45, width: 40, height: 14 }
  ])
  expect(JSON.stringify(rectangles)).toBe(original)
})

it('preserves single partial-word selections and discards empty/invalid rectangles', () => {
  expect(mergePdfTextRects([
    { x: 11, y: 20, width: 7, height: 14 },
    { x: 11, y: 20, width: 0, height: 14 },
    { x: NaN, y: 20, width: 7, height: 14 }
  ])).toEqual([{ x: 11, y: 20, width: 7, height: 14 }])
})
