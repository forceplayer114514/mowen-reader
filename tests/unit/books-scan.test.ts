import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { scanFolder } from '../../src/main/books/scan'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reader-scan-'))
})

describe('扫描文件夹', () => {
  it('找出顶层和子目录里的 epub', async () => {
    writeFileSync(join(dir, 'a.epub'), '')
    mkdirSync(join(dir, '子目录'))
    writeFileSync(join(dir, '子目录', 'b.epub'), '')
    const found = await scanFolder(dir, [])
    expect(found).toEqual([join(dir, 'a.epub'), join(dir, '子目录', 'b.epub')])
  })

  it('忽略非 epub 文件', async () => {
    writeFileSync(join(dir, 'a.epub'), '')
    writeFileSync(join(dir, 'b.pdf'), '')
    writeFileSync(join(dir, 'c.txt'), '')
    expect(await scanFolder(dir, [])).toEqual([join(dir, 'a.epub')])
  })

  it('扩展名大小写不敏感', async () => {
    writeFileSync(join(dir, 'a.EPUB'), '')
    expect(await scanFolder(dir, [])).toEqual([join(dir, 'a.EPUB')])
  })

  it('排除已导入过的路径', async () => {
    writeFileSync(join(dir, 'a.epub'), '')
    writeFileSync(join(dir, 'b.epub'), '')
    expect(await scanFolder(dir, [join(dir, 'a.epub')])).toEqual([join(dir, 'b.epub')])
  })

  it('目录不存在时抛出带路径的错误', async () => {
    await expect(scanFolder(join(dir, '没有'), [])).rejects.toThrow(/没有/)
  })

  it('空目录返回空数组', async () => {
    expect(await scanFolder(dir, [])).toEqual([])
  })

  it('找出深层嵌套三层以上的 epub', async () => {
    mkdirSync(join(dir, '一'))
    mkdirSync(join(dir, '一', '二'))
    mkdirSync(join(dir, '一', '二', '三'))
    writeFileSync(join(dir, '一', '二', '三', 'deep.epub'), '')
    const found = await scanFolder(dir, [])
    expect(found).toEqual([join(dir, '一', '二', '三', 'deep.epub')])
  })

  it('忽略扩展名为 epub.txt 的文件', async () => {
    writeFileSync(join(dir, 'book.epub.txt'), '')
    writeFileSync(join(dir, 'actual.epub'), '')
    const found = await scanFolder(dir, [])
    expect(found).toEqual([join(dir, 'actual.epub')])
  })

  it('遍历名为 epub 的目录并找出其中的 epub 文件', async () => {
    mkdirSync(join(dir, '合集.epub'))
    writeFileSync(join(dir, '合集.epub', 'inner.epub'), '')
    const found = await scanFolder(dir, [])
    expect(found).toEqual([join(dir, '合集.epub', 'inner.epub')])
  })

  it('路径存在但不是文件夹时抛出错误', async () => {
    writeFileSync(join(dir, 'file.txt'), '')
    await expect(scanFolder(join(dir, 'file.txt'), [])).rejects.toThrow('不是文件夹:' + join(dir, 'file.txt'))
  })
})
