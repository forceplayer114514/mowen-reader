import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { createDictionaryService, formatDictionaryEntry, isSingleEnglishWord, parseOnlineDictionary, singleEnglishWord, splitSenses } from '../../src/main/dictionary'

describe('单词词典', () => {
  it('只把单个英文单词路由到词典；释义去重和编号', () => {
    expect(isSingleEnglishWord('running')).toBe(true)
    expect(isSingleEnglishWord("don't")).toBe(true)
    expect(isSingleEnglishWord('running fast')).toBe(false)
    expect(singleEnglishWord('“running,”')).toBe('running')
    expect(singleEnglishWord('don’t')).toBe("don't")
    expect(splitSenses('v. 跑；v. 跑；n. 赛跑\\nn. 路线')).toEqual(['v. 跑', 'n. 赛跑', 'n. 路线'])
    expect(formatDictionaryEntry({ word: 'run', phonetic: 'rʌn', senses: ['v. 跑', 'n. 赛跑'], engine: 'online' }))
      .toContain('1. v. 跑\n2. n. 赛跑')
  })

  it('在线只发送所选单词，显示音标与多义，不接受空词条', async () => {
    const urls: string[] = []
    const directory = await mkdtemp(join(tmpdir(), 'dictionary-test-'))
    const service = createDictionaryService({ directory, workerPath: 'unused', onChanged: () => {},
      onlineUrl: 'http://127.0.0.1/jsonapi',
      fetchImpl: (async (url: string) => {
        urls.push(url)
        return new Response(JSON.stringify({ ec: { word: [{ usphone: 'rʌn', trs: [
          { tr: [{ l: { i: ['v. 跑；奔跑'] } }] }, { tr: [{ l: { i: ['n. 赛跑'] } }] }
        ] }] } }))
      }) as typeof fetch })
    const result = await service.lookup('run', 'online')
    expect(result).toMatchObject({ word: 'run', phonetic: 'rʌn', senses: ['v. 跑', '奔跑', 'n. 赛跑'] })
    expect(new URL(urls[0]).searchParams.get('q')).toBe('run')
    expect(urls[0]).not.toContain('book')
    expect(() => parseOnlineDictionary({}, 'missing')).toThrow('未收录')
    service.dispose()
  })

  it('离线索引直接查词，不走网络', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dictionary-test-'))
    await mkdir(directory, { recursive: true })
    const db = new DatabaseSync(join(directory, 'ecdict.sqlite'))
    db.exec('CREATE TABLE entries (word TEXT PRIMARY KEY COLLATE NOCASE, phonetic TEXT, translation TEXT)')
    db.prepare('INSERT INTO entries VALUES (?, ?, ?)').run('apple', 'ˈæpəl', 'n. 苹果\\nn. 苹果树')
    db.close()
    const service = createDictionaryService({ directory, workerPath: 'unused', onChanged: () => {},
      fetchImpl: (() => { throw new Error('unexpected network') }) as typeof fetch })
    expect(await service.lookup('Apple', 'offline')).toMatchObject({ senses: ['n. 苹果', 'n. 苹果树'], engine: 'offline' })
    await service.remove()
    await expect(service.lookup('apple', 'offline')).rejects.toThrow('未安装')
    service.dispose()
  })
})
