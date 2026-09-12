import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { stageMany, stageOne } from '../../src/main/books/stage'
import { allowSource, clearAllowedSources } from '../../src/main/books/source-gate'

let dataDir: string
let workDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'reader-data-'))
  workDir = mkdtempSync(join(tmpdir(), 'reader-work-'))
  process.env.READER_USER_DATA = dataDir
  clearAllowedSources()
})

describe('stageOne', () => {
  it('已允许的 epub 路径能被复制进库', async () => {
    const src = join(workDir, '书.epub')
    writeFileSync(src, 'X')
    allowSource(src)
    const result = await stageOne(src)
    expect(existsSync(result.filePath)).toBe(true)
  })

  it('没被 allowSource 记录过的路径抛错,且不会复制文件', async () => {
    const src = join(workDir, '书.epub')
    writeFileSync(src, 'X')
    await expect(stageOne(src)).rejects.toThrow(/未经用户选择的路径/)
  })

  it('已允许但不是 .epub 后缀的路径抛错', async () => {
    const src = join(workDir, '书.txt')
    writeFileSync(src, 'X')
    allowSource(src)
    await expect(stageOne(src)).rejects.toThrow(/只支持 EPUB 文件/)
  })
})

describe('stageMany', () => {
  it('按输入顺序依次 stage,返回结果顺序与输入一致', async () => {
    const a = join(workDir, 'a.epub')
    const b = join(workDir, 'b.epub')
    writeFileSync(a, 'A')
    writeFileSync(b, 'B')
    allowSource(a)
    allowSource(b)
    const result = await stageMany([a, b])
    expect(result).toHaveLength(2)
    expect(existsSync(result[0].filePath)).toBe(true)
    expect(existsSync(result[1].filePath)).toBe(true)
  })

  it('中途遇到未被允许的路径会中断,不再处理后面的路径', async () => {
    const a = join(workDir, 'a.epub')
    const bad = join(workDir, 'bad.epub')
    const c = join(workDir, 'c.epub')
    writeFileSync(a, 'A')
    writeFileSync(c, 'C')
    allowSource(a)
    allowSource(c)
    // bad 故意不 allowSource
    await expect(stageMany([a, bad, c])).rejects.toThrow(/未经用户选择的路径/)
  })

  it('空数组返回空数组', async () => {
    expect(await stageMany([])).toEqual([])
  })
})
