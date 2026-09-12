import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  copyEpubIntoLibrary,
  libraryFilePath,
  removeBookFiles,
  writeCover
} from '../../src/main/books/import'

let dataDir: string
let workDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'reader-data-'))
  workDir = mkdtempSync(join(tmpdir(), 'reader-work-'))
  process.env.READER_USER_DATA = dataDir
})

describe('导入文件', () => {
  it('把源文件复制进库,内容一致', async () => {
    const src = join(workDir, '测试书.epub')
    writeFileSync(src, 'EPUB-CONTENT')
    const result = await copyEpubIntoLibrary(src)
    expect(existsSync(result.filePath)).toBe(true)
    expect(readFileSync(result.filePath, 'utf8')).toBe('EPUB-CONTENT')
  })

  it('复制后删掉源文件不影响库内副本', async () => {
    const src = join(workDir, '测试书.epub')
    writeFileSync(src, 'EPUB-CONTENT')
    const result = await copyEpubIntoLibrary(src)
    const { rmSync } = await import('node:fs')
    rmSync(src)
    expect(readFileSync(result.filePath, 'utf8')).toBe('EPUB-CONTENT')
  })

  it('同一个文件导入两次得到两个不同的 id 和两份副本', async () => {
    const src = join(workDir, '测试书.epub')
    writeFileSync(src, 'X')
    const a = await copyEpubIntoLibrary(src)
    const b = await copyEpubIntoLibrary(src)
    expect(a.id).not.toBe(b.id)
    expect(a.filePath).not.toBe(b.filePath)
    expect(existsSync(a.filePath)).toBe(true)
    expect(existsSync(b.filePath)).toBe(true)
  })

  it('源文件不存在时抛出带路径的错误', async () => {
    await expect(copyEpubIntoLibrary(join(workDir, '没有这个.epub'))).rejects.toThrow(
      /没有这个\.epub/
    )
  })

  it('封面写入后能读回原始字节', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71])
    const path = await writeCover('book-1', bytes)
    expect(Array.from(readFileSync(path))).toEqual([137, 80, 78, 71])
  })

  it('删除会同时清掉书文件和封面,重复删除不报错', async () => {
    const src = join(workDir, 'a.epub')
    writeFileSync(src, 'X')
    const imported = await copyEpubIntoLibrary(src)
    const cover = await writeCover(imported.id, new Uint8Array([1]))
    await removeBookFiles({ filePath: imported.filePath, coverPath: cover })
    expect(existsSync(imported.filePath)).toBe(false)
    expect(existsSync(cover)).toBe(false)
    await expect(
      removeBookFiles({ filePath: imported.filePath, coverPath: cover })
    ).resolves.toBeUndefined()
  })

  it('没有封面时删除书文件不报错', async () => {
    const src = join(workDir, 'b.epub')
    writeFileSync(src, 'Y')
    const imported = await copyEpubIntoLibrary(src)
    await expect(
      removeBookFiles({ filePath: imported.filePath, coverPath: null })
    ).resolves.toBeUndefined()
    expect(existsSync(imported.filePath)).toBe(false)
  })
})

describe('libraryFilePath', () => {
  it('合法 uuid 得到书库目录内的路径', () => {
    const id = '3fa85f64-5717-4562-b3fc-2c963f66afa6'
    const path = libraryFilePath(id)
    expect(path).toBe(join(dataDir, 'books', `${id}.epub`))
  })

  it.each([
    ['路径穿越', '../../../etc/passwd'],
    ['绝对路径', '/etc/passwd'],
    ['空字符串', ''],
    ['单个双点', '..'],
    ['形似但不是 uuid', 'abc']
  ])('%s 会被拒绝:%s', (_label, bad) => {
    expect(() => libraryFilePath(bad)).toThrow()
  })

  it('copyEpubIntoLibrary 返回的路径与 libraryFilePath(id) 一致', async () => {
    const src = join(workDir, 'c.epub')
    writeFileSync(src, 'Z')
    const result = await copyEpubIntoLibrary(src)
    expect(result.filePath).toBe(libraryFilePath(result.id))
  })
})
