import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { booksDir, coversDir, dbFile, resolveDataDir } from '../../src/main/paths'

const original = process.env.READER_USER_DATA

afterEach(() => {
  if (original === undefined) delete process.env.READER_USER_DATA
  else process.env.READER_USER_DATA = original
})

describe('应用数据目录', () => {
  it('READER_USER_DATA 存在时以它为根', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reader-'))
    process.env.READER_USER_DATA = dir
    expect(resolveDataDir()).toBe(dir)
    expect(booksDir()).toBe(join(dir, 'books'))
    expect(coversDir()).toBe(join(dir, 'covers'))
    expect(dbFile()).toBe(join(dir, 'reader.db'))
  })

  it('调用后子目录已被建出来', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reader-'))
    process.env.READER_USER_DATA = dir
    const b = booksDir()
    const c = coversDir()
    expect(existsSync(b)).toBe(true)
    expect(existsSync(c)).toBe(true)
  })

  it('READER_USER_DATA 未设置时抛出应用数据目录未初始化', () => {
    delete process.env.READER_USER_DATA
    expect(() => resolveDataDir()).toThrow('应用数据目录未初始化')
  })
})
