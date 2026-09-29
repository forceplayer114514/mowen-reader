import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { createDictionaryService } from '../../src/main/dictionary'

test('离线词典下载、校验、CSV 导入、重启后查词与删除', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reader-dictionary-'))
  const csv = Buffer.from('word,phonetic,definition,translation\n"run",rʌn,,"v. 跑；奔跑\\nn. 赛跑"\n"apple",ˈæpəl,,"n. 苹果，水果"\n')
  const sha = createHash('sha1').update(`blob ${csv.length}\0`).update(csv).digest('hex')
  const deps = { directory, workerPath: resolve('out/main/dictionary-worker.js'), onChanged: () => {},
    source: { url: 'https://example.test/dictionary.csv', bytes: csv.length, sha },
    fetchImpl: (async () => new Response(new Uint8Array(csv))) as typeof fetch }
  try {
    const service = createDictionaryService(deps)
    await service.download()
    expect(service.snapshot().status).toBe('installed')
    expect(await service.lookup('RUN', 'offline')).toMatchObject({ phonetic: 'rʌn', senses: ['v. 跑', '奔跑', 'n. 赛跑'] })
    service.dispose()
    const reopened = createDictionaryService(deps)
    expect((await reopened.lookup('apple', 'offline')).senses).toContain('n. 苹果，水果')
    await reopened.remove()
    await expect(reopened.lookup('run', 'offline')).rejects.toThrow('未安装')
    reopened.dispose()
    const tampered = createDictionaryService({ ...deps, source: { ...deps.source, sha: '0'.repeat(40) } })
    await tampered.download()
    expect(tampered.snapshot()).toMatchObject({ status: 'error', message: '词典下载校验失败' })
    await expect(tampered.lookup('run', 'offline')).rejects.toThrow('未安装')
    tampered.dispose()
  } finally { await rm(directory, { recursive: true, force: true }) }
})
