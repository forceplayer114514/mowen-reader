import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  copyEpubIntoLibrary,
  coverExtension,
  coverPath,
  discardStagedFile,
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
    const id = '3fa85f64-5717-4562-b3fc-2c963f66afa6'
    const bytes = new Uint8Array([137, 80, 78, 71])
    const path = await writeCover(id, bytes)
    expect(Array.from(readFileSync(path))).toEqual([137, 80, 78, 71])
  })

  it('封面文件名的扩展名按真实字节的魔数推导,不是不分青红皂白地写成 .png', async () => {
    const id = '3fa85f64-5717-4562-b3fc-2c963f66afa6'
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0])
    const path = await writeCover(id, jpeg)
    expect(path).toBe(join(dataDir, 'covers', `${id}.jpg`))
    expect(existsSync(path)).toBe(true)
  })

  it('认不出格式的字节退回 .png,和 coverPath 的默认扩展名一致', async () => {
    const id = '3fa85f64-5717-4562-b3fc-2c963f66afa6'
    const unknown = new Uint8Array([1, 2, 3, 4])
    const path = await writeCover(id, unknown)
    expect(path).toBe(coverPath(id))
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

describe('coverPath', () => {
  it('合法 uuid 得到封面目录内的路径', () => {
    const id = '3fa85f64-5717-4562-b3fc-2c963f66afa6'
    const path = coverPath(id)
    expect(path).toBe(join(dataDir, 'covers', `${id}.png`))
  })

  it.each([
    ['路径穿越', '../../../etc/passwd'],
    ['绝对路径', '/etc/passwd'],
    ['空字符串', ''],
    ['单个双点', '..'],
    ['形似但不是 uuid', 'abc']
  ])('%s 会被拒绝:%s', (_label, bad) => {
    expect(() => coverPath(bad)).toThrow()
  })

  it('writeCover 使用 coverPath,非法 id 被拒绝', async () => {
    await expect(writeCover('../../../etc/passwd', new Uint8Array([1]))).rejects.toThrow(
      /无效的书籍标识/
    )
  })
})

describe('coverExtension', () => {
  it.each([
    ['PNG', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'png'],
    ['JPEG', [0xff, 0xd8, 0xff, 0xe0], 'jpg'],
    ['GIF', [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 'gif'],
    ['BMP', [0x42, 0x4d, 0, 0, 0, 0], 'bmp'],
    ['认不出的字节', [1, 2, 3, 4], 'png']
  ])('%s 的魔数推导出 .%s', (_label, bytes, ext) => {
    expect(coverExtension(new Uint8Array(bytes))).toBe(ext)
  })

  it('WEBP 需要同时匹配 RIFF 头和 WEBP 标记', () => {
    // RIFF....WEBP:前 4 字节 RIFF,中间 4 字节是文件大小(这里随便填),
    // 第 9-12 字节必须是 WEBP 才能确认,不能只看开头的 RIFF。
    const webp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50
    ])
    expect(coverExtension(webp)).toBe('webp')
  })

  it('只有 RIFF 头、没有 WEBP 标记时不会被误判', () => {
    const notWebp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(coverExtension(notWebp)).toBe('png')
  })
})

describe('discardStagedFile', () => {
  it('封面已写入时,丢弃同时删掉 EPUB 和封面', async () => {
    const src = join(workDir, 'd.epub')
    writeFileSync(src, 'BOOK-CONTENT')
    const imported = await copyEpubIntoLibrary(src)
    const writtenCoverPath = await writeCover(imported.id, new Uint8Array([255, 254]))

    expect(existsSync(imported.filePath)).toBe(true)
    expect(existsSync(writtenCoverPath)).toBe(true)

    await discardStagedFile(imported.id)

    expect(existsSync(imported.filePath)).toBe(false)
    expect(existsSync(writtenCoverPath)).toBe(false)
  })

  it('没有封面时,丢弃仍然删掉 EPUB,不报错', async () => {
    const src = join(workDir, 'e.epub')
    writeFileSync(src, 'ANOTHER-BOOK')
    const imported = await copyEpubIntoLibrary(src)

    expect(existsSync(imported.filePath)).toBe(true)

    await expect(discardStagedFile(imported.id)).resolves.toBeUndefined()

    expect(existsSync(imported.filePath)).toBe(false)
  })

  it('封面的真实扩展名不是默认的 .png 时,丢弃仍然能找到并删掉它', async () => {
    const src = join(workDir, 'f.epub')
    writeFileSync(src, 'YET-ANOTHER-BOOK')
    const imported = await copyEpubIntoLibrary(src)
    // JPEG 魔数,写出来的文件会是 <id>.jpg,不是 coverPath(id) 默认猜的 <id>.png——
    // discardStagedFile 不能靠拼接默认扩展名去删,必须真的找到这个文件。
    const writtenCoverPath = await writeCover(imported.id, new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))
    expect(writtenCoverPath).not.toBe(coverPath(imported.id))
    expect(existsSync(writtenCoverPath)).toBe(true)

    await discardStagedFile(imported.id)

    expect(existsSync(writtenCoverPath)).toBe(false)
  })
})
