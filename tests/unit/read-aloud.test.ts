import { expect, it } from 'vitest'
import { speechChunks } from '../../src/renderer/reader/ReadAloud'

it('splits long multilingual pages without losing characters', () => {
  const text = '你好🙂 hello '.repeat(100)
  const cleaned = text.replace(/\s+/g, ' ').trim()
  const parts = speechChunks(text)
  expect(parts.join('')).toBe(cleaned)
  expect(parts.every((part) => Array.from(part).length <= 180)).toBe(true)
  expect(speechChunks('  \n  ')).toEqual([])
})
