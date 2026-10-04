import { expect, it } from 'vitest'
import { normalizePdfView, pdfImageFilter } from '../../src/renderer/reader/types'
import { assertAllowedSettingKey } from '../../src/main/db/settings'

it('PDF view settings have an independent key and validate cached/external values', () => {
  expect(() => assertAllowedSettingKey('pdfView')).not.toThrow()
  for (const raw of [null, 'broken', 'null', '[]', 42]) {
    expect(normalizePdfView(raw)).toEqual({ mode: 'page', scale: 1, contrast: 1 })
  }
  expect(normalizePdfView('{"mode":"width","scale":2}')).toEqual({ mode: 'width', scale: 2, contrast: 1 })
  expect(normalizePdfView({ mode: 'custom', scale: Infinity })).toEqual({ mode: 'custom', scale: 1, contrast: 1 })
  expect(normalizePdfView({ mode: 'invalid', scale: 0 })).toEqual({ mode: 'page', scale: 0.25, contrast: 1 })
  expect(normalizePdfView({ mode: 'custom', scale: 100 })).toEqual({ mode: 'custom', scale: 4, contrast: 1 })
})

it('contrast preserves old settings and clamps invalid or excessive enhancement', () => {
  expect(normalizePdfView({ contrast: 1.35 }).contrast).toBe(1.35)
  for (const contrast of [undefined, null, '2', Infinity, NaN, -1]) {
    expect(normalizePdfView({ contrast }).contrast).toBe(1)
  }
  expect(normalizePdfView({ contrast: 10 }).contrast).toBe(2)
})

it('scan enhancement preserves the paper white point and runs before night inversion', () => {
  expect(pdfImageFilter('light', 1)).toBe('brightness(1) contrast(1)')
  expect(pdfImageFilter('light', 1.5)).toBe('brightness(0.75) contrast(2)')
  expect(pdfImageFilter('dark', 1.5)).toBe('brightness(0.75) contrast(2) invert(.9) hue-rotate(180deg)')
  for (const strength of [1, 1.25, 1.5, 2]) {
    const cssContrast = 2 * strength - 1
    const value = (x: number): number => (x * strength / cssContrast - .5) * cssContrast + .5
    expect(value(1)).toBeCloseTo(1)
    expect(value(.8)).toBeCloseTo(1 - .2 * strength)
  }
})
