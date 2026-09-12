import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  allowSource,
  allowSources,
  assertAllowed,
  assertEpub,
  clearAllowedSources
} from '../../src/main/books/source-gate'

beforeEach(() => {
  clearAllowedSources()
})

describe('assertAllowed', () => {
  it('记录过的路径能通过', () => {
    const p = '/Users/x/书库/a.epub'
    allowSource(p)
    expect(assertAllowed(p)).toBe(p)
  })

  it('没记录过的路径会抛错', () => {
    expect(() => assertAllowed('/Users/x/.ssh/id_rsa')).toThrow(/未经用户选择的路径/)
  })

  it('批量记录后每一条都能通过', () => {
    const paths = ['/a/1.epub', '/a/2.epub']
    allowSources(paths)
    for (const p of paths) expect(assertAllowed(p)).toBe(p)
  })

  it('记录时带多余的 /. 不影响之后用等价形式校验', () => {
    const dir = '/Users/x/书库'
    allowSource(dir + '/.')
    expect(assertAllowed(dir)).toBe(dir)
  })

  it('记录时带 .. 段,解析到同一位置后仍能通过', () => {
    const real = '/Users/x/书库'
    allowSource('/Users/x/其他/../书库')
    expect(assertAllowed(real)).toBe(real)
  })

  it('clearAllowedSources 清空后,原先记录过的路径也会被拒绝', () => {
    const p = '/Users/x/书库/a.epub'
    allowSource(p)
    clearAllowedSources()
    expect(() => assertAllowed(p)).toThrow()
  })
})

describe('assertEpub', () => {
  it('.epub 结尾的路径通过', () => {
    expect(() => assertEpub(join('/a', 'b.epub'))).not.toThrow()
  })

  it('.EPUB 大写结尾的路径也通过', () => {
    expect(() => assertEpub('/a/b.EPUB')).not.toThrow()
  })

  it('非 epub 文件被拒绝', () => {
    expect(() => assertEpub('/a/id_rsa')).toThrow(/只支持 EPUB 文件/)
  })
})
