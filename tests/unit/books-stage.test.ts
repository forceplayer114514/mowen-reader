import { existsSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { stageMany, stageOne } from '../../src/main/books/stage'
import { allowSource, clearAllowedSources } from '../../src/main/books/source-gate'
import { booksDir } from '../../src/main/paths'

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

describe('符号链接拒绝', () => {
  it('已允许但指向真实文件的符号链接会被拒绝', async () => {
    const target = join(workDir, '真实文件.epub')
    writeFileSync(target, 'REAL')
    const link = join(workDir, '链接.epub')
    symlinkSync(target, link)
    allowSource(link)
    await expect(stageOne(link)).rejects.toThrow(/不接受符号链接/)
  })

  it('符号链接被拒绝后,目标文件的内容不会被复制进库', async () => {
    const target = join(workDir, '真实文件2.epub')
    writeFileSync(target, 'REAL-SECRET')
    const link = join(workDir, '链接2.epub')
    symlinkSync(target, link)
    allowSource(link)
    await expect(stageOne(link)).rejects.toThrow()
    expect(readdirSync(booksDir())).toHaveLength(0)
  })

  it('stageMany 中途遇到符号链接会中断,不再处理后面的路径', async () => {
    const a = join(workDir, 'a.epub')
    const target = join(workDir, '真实文件3.epub')
    const link = join(workDir, 'bad-link.epub')
    const c = join(workDir, 'c.epub')
    writeFileSync(a, 'A')
    writeFileSync(target, 'REAL3')
    symlinkSync(target, link)
    writeFileSync(c, 'C')
    allowSource(a)
    allowSource(link)
    allowSource(c)
    await expect(stageMany([a, link, c])).rejects.toThrow(/不接受符号链接/)
  })
})
