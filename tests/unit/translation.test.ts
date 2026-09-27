/**
 * 翻译服务聚焦测试（全部合成文本，不碰真实用户目录，不下载真实模型）。
 *
 * - 在线：fetch 全 mock（onlineBaseUrl 指向 example 域名），断言分块/限流/
 *   配额/超时/取消/知情同意。
 * - 离线：packFiles 覆盖为字节级小 manifest（40 位 git blob sha1 + 64 位真实
 *   内容 SHA256，与生产校验规则一致），fetch mock 按名返回精确字节；
 *   推理走 translateOffline 注入（不断言真实模型效果）。
 * - 下载：并发共享、取消/删除不迟到安装、remove 只删白名单。
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, describe, expect, it, vi } from 'vitest'
import {
  createTranslationService,
  MAX_CHUNK_BYTES,
  splitTranslationChunks
} from '../../src/main/translation'
import type { PackFileEntry, TranslationServiceDeps, TranslationSnapshot } from '../../src/shared/translation-types'

const ONLINE_BASE = 'https://online.test'

function gitBlobSha1(data: Buffer): string {
  return createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex')
}

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function tinyManifest(): { files: PackFileEntry[]; bodies: Map<string, Buffer> } {
  const a = Buffer.from('a-01')
  const b = Buffer.from('b-02!')
  const files: PackFileEntry[] = [
    // 40 位：git blob sha1 强校验（模拟小文件）。
    { name: 'a.bin', size: a.length, etag: gitBlobSha1(a) },
    // 64 位：文件内容真实 SHA256 强校验（模拟 LFS 大文件）。
    { name: 'sub/b.bin', size: b.length, etag: sha256Hex(b) }
  ]
  return { files, bodies: new Map([['a.bin', a], ['sub/b.bin', b]]) }
}

/** Response BodyInit 的 TS 类型不含 Buffer，一律包一层 Uint8Array（运行时等价）。 */
function bodyResponse(body: Buffer): Response {
  return new Response(new Uint8Array(body))
}

function downloadFetch(bodies: Map<string, Buffer>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const body = bodies.get(String(input))
    if (!body) return new Response('missing', { status: 404 })
    return bodyResponse(body)
  }) as unknown as typeof fetch
}

interface Harness {
  deps: TranslationServiceDeps
  settings: Map<string, string>
  seen: TranslationSnapshot[]
  directory: string
}

async function harness(over: Partial<TranslationServiceDeps> = {}): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'translation-test-'))
  const settings = new Map<string, string>()
  const seen: TranslationSnapshot[] = []
  const deps: TranslationServiceDeps = {
    directory,
    getSetting: (key) => settings.get(key) ?? null,
    onChanged: (snap) => {
      seen.push(snap)
    },
    onlineBaseUrl: ONLINE_BASE,
    timeoutMs: 2000,
    ...over
  }
  return { deps, settings, seen, directory }
}

function onlineFetch(translated: (q: string) => string): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input)
    expect(url.startsWith(`${ONLINE_BASE}/get?`)).toBe(true)
    const q = new URL(url).searchParams.get('q') ?? ''
    expect(Buffer.byteLength(q, 'utf8')).toBeLessThanOrEqual(MAX_CHUNK_BYTES)
    return new Response(
      JSON.stringify({ responseData: { translatedText: translated(q) }, responseStatus: 200 })
    )
  }) as unknown as typeof fetch
}

/** 合成英文长文（无真实语料），用于分块测试。 */
function syntheticEnglish(sentences: number): string {
  const parts: string[] = []
  for (let i = 0; i < sentences; i++) {
    parts.push(`Synthetic sentence number ${i} for chunk testing purposes.`)
  }
  return parts.join(' ')
}

describe('翻译输入校验', () => {
  it('空文本与超长文本直接报错（错误不回显原文）', async () => {
    const h = await harness({ fetchImpl: onlineFetch((q) => q) })
    h.settings.set('translation.onlineConsent', 'true')
    const svc = createTranslationService(h.deps)
    await expect(svc.translate('   ')).rejects.toThrow('没有可翻译')
    const secret = `SECRET-${'x'.repeat(10010)}`
    const error: unknown = await svc.translate(secret).catch((e: unknown) => e)
    assert(error instanceof Error)
    expect(error.message).toMatch(/10000/)
    expect(error.message).not.toContain('SECRET')
    svc.dispose()
  })

  it('非英→简中语言对明确报错', async () => {
    const h = await harness({ fetchImpl: onlineFetch((q) => q) })
    h.settings.set('translation.onlineConsent', 'true')
    h.settings.set('translation.source', 'fr')
    await expect(createTranslationService(h.deps).translate('Hello')).rejects.toThrow('仅支持')
    h.settings.set('translation.source', 'en')
    h.settings.set('translation.target', 'en')
    await expect(createTranslationService(h.deps).translate('Hello')).rejects.toThrow('仅支持')
  })

  it('未知翻译模式明确报错', async () => {
    const h = await harness({ fetchImpl: onlineFetch((q) => q) })
    h.settings.set('translation.mode', 'quantum')
    await expect(createTranslationService(h.deps).translate('Hello')).rejects.toThrow('未知')
  })
})

describe('在线翻译（MyMemory，全 mock）', () => {
  it('释放服务会取消正在进行的翻译，不留下后台任务', async () => {
    const hanging = vi.fn((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      }))
    const h = await harness({ fetchImpl: hanging as typeof fetch })
    h.settings.set('translation.onlineConsent', 'true')
    const svc = createTranslationService(h.deps)
    const pending = svc.translate('Synthetic text').catch((error: unknown) => error)
    await vi.waitFor(() => expect(hanging).toHaveBeenCalledOnce())
    svc.dispose()
    expect(await pending).toMatchObject({ message: '翻译已取消' })
  })
  it('默认需要知情同意；同意后只发选中文本并返回 online 引擎', async () => {
    const seen: string[] = []
    const h = await harness({
      fetchImpl: onlineFetch((q) => {
        seen.push(q)
        return `译:${q}`
      })
    })
    const svc = createTranslationService(h.deps)
    await expect(svc.translate('Hello world')).rejects.toThrow('同意')
    expect(seen).toEqual([])
    h.settings.set('translation.onlineConsent', 'true')
    const result = await svc.translate('Hello world')
    expect(result).toEqual({ text: '译:Hello world', engine: 'online' })
    expect(seen).toEqual(['Hello world'])
    svc.dispose()
  })

  it('长文本按句/词切块，每块 ≤500 字节，译文按原序拼接', async () => {
    const text = syntheticEnglish(60)
    expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(MAX_CHUNK_BYTES)
    const chunks = splitTranslationChunks(text)
    expect(chunks.join('')).toBe(text)
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, 'utf8')).toBeLessThanOrEqual(MAX_CHUNK_BYTES)
    }
    const h = await harness({ fetchImpl: onlineFetch((q) => `<${q}>`) })
    h.settings.set('translation.onlineConsent', 'true')
    const svc = createTranslationService(h.deps)
    const result = await svc.translate(text)
    expect(result.engine).toBe('online')
    expect(result.text).toBe(chunks.map((c) => `<${c}>`).join(''))
    svc.dispose()
  })

  it('无空格超长 token 按字节硬切且不破坏 UTF-8', async () => {
    const text = `中${'文'.repeat(400)} END`
    const chunks = splitTranslationChunks(text)
    expect(chunks.join('')).toBe(text)
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, 'utf8')).toBeLessThanOrEqual(MAX_CHUNK_BYTES)
    }
  })

  it('中文标点/前导空白/换行/emoji 只在边界切分且拼接恒等原文', async () => {
    const text = `  前言：合成测试。\n第二段！包含？多种；标点…以及 emoji 🎉 结尾。\n${'合成句子填充内容。'.repeat(80)}尾部留白   \n`
    expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(MAX_CHUNK_BYTES)
    const chunks = splitTranslationChunks(text)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(text)
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, 'utf8')).toBeLessThanOrEqual(MAX_CHUNK_BYTES)
    }
  })

  it('中文长文在线翻译：请求均 ≤500 字节且结果按序拼接', async () => {
    const text = `合成中文长文。${'填充句子内容！'.repeat(120)}结尾。`
    const chunks = splitTranslationChunks(text)
    expect(chunks.join('')).toBe(text)
    const h = await harness({ fetchImpl: onlineFetch((q) => `[${q}]`) })
    h.settings.set('translation.onlineConsent', 'true')
    const svc = createTranslationService(h.deps)
    const result = await svc.translate(text)
    expect(result).toEqual({ text: chunks.map((c) => `[${c}]`).join(''), engine: 'online' })
    svc.dispose()
  })

  it('429 / 配额耗尽 / 无效响应分别报明确错误', async () => {
    const consent: Record<string, string> = { 'translation.onlineConsent': 'true' }
    const mk = (fetchImpl: typeof fetch): ReturnType<typeof createTranslationService> => {
      const dir = join(tmpdir(), `translation-unused-${Math.random()}`)
      return createTranslationService({
        directory: dir,
        getSetting: (k) => consent[k] ?? null,
        onChanged: () => {},
        onlineBaseUrl: ONLINE_BASE,
        timeoutMs: 1000,
        fetchImpl
      })
    }
    await expect(
      mk((async () => new Response('limited', { status: 429 })) as unknown as typeof fetch).translate('Hello')
    ).rejects.toThrow('限流')
    await expect(
      mk(
        (async () =>
          new Response(
            JSON.stringify({ responseData: { translatedText: 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS' }, responseStatus: 200 })
          )) as unknown as typeof fetch
      ).translate('Hello')
    ).rejects.toThrow('额度')
    await expect(
      mk((async () => new Response('not-json{{', { status: 200 })) as unknown as typeof fetch).translate('Hello')
    ).rejects.toThrow('无效')
    await expect(
      mk((async () => new Response('oops', { status: 500 })) as unknown as typeof fetch).translate('Hello')
    ).rejects.toThrow('HTTP 500')
  })

  it('超时与主动取消分别报错', async () => {
    const hanging: typeof fetch = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })) as unknown as typeof fetch
    const h = await harness({ fetchImpl: hanging, timeoutMs: 30 })
    h.settings.set('translation.onlineConsent', 'true')
    await expect(createTranslationService(h.deps).translate('Hello')).rejects.toThrow('超时')

    const h2 = await harness({ fetchImpl: hanging })
    h2.settings.set('translation.onlineConsent', 'true')
    const controller = new AbortController()
    const pending = createTranslationService(h2.deps).translate('Hello', controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow('取消')
  })
})

describe('离线包下载与安装态', () => {
  it('下载成功：进度推进、原子落盘、重启后仍为 installed，且幂等不重下', async () => {
    const { files, bodies } = tinyManifest()
    let calls = 0
    const fetchImpl = (async (input: string | URL | Request) => {
      calls += 1
      const body = bodies.get(String(input))
      if (!body) return new Response('missing', { status: 404 })
      return bodyResponse(body)
    }) as unknown as typeof fetch
    const h = await harness({ fetchImpl, packFiles: files })
    const svc = createTranslationService(h.deps)
    const final = await svc.downloadPack()
    expect(final.status).toBe('installed')
    expect(final.total).toBe(files.reduce((s, f) => s + f.size, 0))
    expect(final.size).toBe(final.total)
    const statuses = h.seen.map((s) => s.status)
    expect(statuses).toContain('downloading')
    expect(statuses[statuses.length - 1]).toBe('installed')
    expect(statuses.indexOf('downloading')).toBeLessThan(statuses.lastIndexOf('installed'))
    expect(statuses.slice(statuses.indexOf('downloading'), -1).every((s) => s === 'downloading')).toBe(true)
    for (const file of files) {
      const info = await stat(join(h.directory, file.name))
      expect(info.size).toBe(file.size)
    }
    const marker = JSON.parse(await readFile(join(h.directory, 'pack.json'), 'utf8')) as { files: unknown }
    expect(Array.isArray(marker.files)).toBe(true)
    await expect(stat(join(h.directory, '.staging'))).rejects.toThrow()

    // 重启（新实例同目录）仍识别为已安装；再次下载不再请求网络。
    const seen2: TranslationSnapshot[] = []
    const svc2 = createTranslationService({ ...h.deps, onChanged: (s) => seen2.push(s) })
    await vi.waitFor(() => expect(seen2.length).toBeGreaterThan(0))
    expect(seen2[seen2.length - 1]?.status).toBe('installed')
    const before = calls
    await svc2.downloadPack()
    expect(calls).toBe(before)
    svc.dispose()
    svc2.dispose()
  })

  it('并发下载共享同一份工作（单次网络、不重复落盘）', async () => {
    const { files, bodies } = tinyManifest()
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fetchImpl = (async (input: string | URL | Request) => {
      calls += 1
      await gate
      return bodyResponse(bodies.get(String(input))!)
    }) as unknown as typeof fetch
    const h = await harness({ fetchImpl, packFiles: files })
    const svc = createTranslationService(h.deps)
    const first = svc.downloadPack()
    const second = svc.downloadPack()
    expect(second).toBe(first)
    release()
    const [r1, r2] = await Promise.all([first, second])
    expect(r1.status).toBe('installed')
    expect(r2.status).toBe('installed')
    expect(calls).toBe(files.length)
    svc.dispose()
  })

  it('大小不符与 sha1 不符都落为 error 且不写 marker', async () => {
    const { files, bodies } = tinyManifest()
    const short = (async (input: string | URL | Request) =>
      bodyResponse((bodies.get(String(input)) ?? Buffer.alloc(0)).subarray(0, 1))) as unknown as typeof fetch
    const h = await harness({ fetchImpl: short, packFiles: files })
    const svc = createTranslationService(h.deps)
    const snap = await svc.downloadPack()
    expect(snap.status).toBe('error')
    expect(snap.message).toMatch(/大小不符/)
    await expect(stat(join(h.directory, 'pack.json'))).rejects.toThrow()
    svc.dispose()

    const badSha: PackFileEntry[] = [{ ...files[0]!, etag: '1'.repeat(40), size: files[0]!.size }]
    const good = (async () => bodyResponse(bodies.get('a.bin')!)) as unknown as typeof fetch
    const h2 = await harness({ fetchImpl: good, packFiles: badSha })
    const svc2 = createTranslationService(h2.deps)
    const snap2 = await svc2.downloadPack()
    expect(snap2.status).toBe('error')
    assert(typeof snap2.message === 'string')
    expect(snap2.message).toMatch(/校验失败/)
    svc2.dispose()
  })

  it('同体积篡改内容被 SHA256 校验拒绝且不写 marker', async () => {
    const { files, bodies } = tinyManifest()
    const corrupt = Buffer.from(bodies.get('sub/b.bin')!)
    corrupt[0] = (corrupt[0] as number) ^ 0xff
    expect(corrupt.length).toBe(bodies.get('sub/b.bin')!.length)
    const fetchImpl = (async (input: string | URL | Request) => {
      const name = String(input)
      return bodyResponse(name === 'sub/b.bin' ? corrupt : bodies.get(name)!)
    }) as unknown as typeof fetch
    const h = await harness({ fetchImpl, packFiles: files })
    const svc = createTranslationService(h.deps)
    const snap = await svc.downloadPack()
    expect(snap.status).toBe('error')
    assert(typeof snap.message === 'string')
    expect(snap.message).toMatch(/校验失败/)
    await expect(stat(join(h.directory, 'pack.json'))).rejects.toThrow()
    svc.dispose()
  })

  it('取消下载后状态为 error(已取消)且无残留', async () => {
    const { files } = tinyManifest()
    const hanging: typeof fetch = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })) as unknown as typeof fetch
    const h = await harness({ fetchImpl: hanging, packFiles: files })
    const svc = createTranslationService(h.deps)
    const pending = svc.downloadPack()
    await vi.waitFor(() => expect(h.seen.length).toBeGreaterThan(0))
    svc.cancelDownload()
    const snap = await pending
    expect(snap.status).toBe('error')
    expect(snap.message).toMatch(/取消/)
    await expect(stat(join(h.directory, 'pack.json'))).rejects.toThrow()
    svc.dispose()
  })

  it('取消/删除后迟到的数据不会迟到安装', async () => {
    const { files, bodies } = tinyManifest()
    // 故意忽略 abort：延迟后仍返回完整数据，模拟迟到响应。
    const slowBlind: typeof fetch = ((input: string | URL | Request) =>
      new Promise((resolve) => {
        setTimeout(() => resolve(bodyResponse(bodies.get(String(input))!)), 50)
      })) as unknown as typeof fetch
    const h = await harness({ fetchImpl: slowBlind, packFiles: files })
    const svc = createTranslationService(h.deps)
    const pending = svc.downloadPack()
    await new Promise((r) => setTimeout(r, 10))
    const removed = await svc.removePack()
    expect(removed.status).toBe('not-installed')
    await pending
    // 放行所有迟到响应后，仍不得出现 marker 或安装态。
    await new Promise((r) => setTimeout(r, 120))
    await expect(stat(join(h.directory, 'pack.json'))).rejects.toThrow()
    expect(svc.snapshot().status).toBe('not-installed')
    svc.dispose()
  })

  it('removePack 只删白名单文件（未知文件保留）；符号链接目录拒绝删除', async () => {
    const { files, bodies } = tinyManifest()
    const h = await harness({ fetchImpl: downloadFetch(bodies), packFiles: files })
    const svc = createTranslationService(h.deps)
    await svc.downloadPack()
    await writeFile(join(h.directory, 'user-keep.txt'), 'keep')
    await mkdir(join(h.directory, 'onnx'), { recursive: true })
    await writeFile(join(h.directory, 'onnx', 'extra-unknown.bin'), 'unknown')
    const removed = await svc.removePack()
    expect(removed.status).toBe('not-installed')
    await expect(stat(join(h.directory, 'a.bin'))).rejects.toThrow()
    expect((await readFile(join(h.directory, 'user-keep.txt'), 'utf8'))).toBe('keep')
    // 未知文件不在白名单：原样保留，非空 onnx 目录也不误伤。
    expect((await readFile(join(h.directory, 'onnx', 'extra-unknown.bin'), 'utf8'))).toBe('unknown')
    svc.dispose()

    const real = await mkdtemp(join(tmpdir(), 'translation-real-'))
    const link = join(tmpdir(), `translation-link-${Date.now()}`)
    await symlink(real, link)
    const h2 = await harness({ packFiles: files })
    const svc2 = createTranslationService({ ...h2.deps, directory: link })
    await expect(svc2.removePack()).rejects.toThrow(/符号链接/)
    svc2.dispose()
  })
})

describe('离线翻译路由', () => {
  it('未安装时拒绝且不触发任何下载（无隐式网络）', async () => {
    const fetchImpl = (async () => {
      throw new Error('must not fetch during translate')
    }) as unknown as typeof fetch
    const h = await harness({ fetchImpl })
    h.settings.set('translation.mode', 'offline')
    const svc = createTranslationService(h.deps)
    await expect(svc.translate('Hello world')).rejects.toThrow('未安装')
    svc.dispose()
  })

  it('已安装 + 注入推理：走 offline 引擎并支持取消', async () => {
    const { files, bodies } = tinyManifest()
    const h = await harness({
      fetchImpl: downloadFetch(bodies),
      packFiles: files,
      translateOffline: async (text) => `离线:${text}`
    })
    h.settings.set('translation.mode', 'offline')
    const svc = createTranslationService(h.deps)
    await svc.downloadPack()
    const result = await svc.translate('Hello world')
    expect(result).toEqual({ text: '离线:Hello world', engine: 'offline' })

    const controller = new AbortController()
    controller.abort()
    await expect(svc.translate('Hello', controller.signal)).rejects.toThrow('取消')
    svc.dispose()
  })

  it('缺 worker 时报出可行动的集成错误', async () => {
    const { files, bodies } = tinyManifest()
    const h3 = await harness({
      fetchImpl: downloadFetch(bodies),
      packFiles: files,
      workerPath: '/tmp/translation-no-such-worker.js'
    })
    h3.settings.set('translation.mode', 'offline')
    const svc = createTranslationService(h3.deps)
    await svc.downloadPack()
    await expect(svc.translate('Hello')).rejects.toThrow(/worker/)
    svc.dispose()
  })
})
