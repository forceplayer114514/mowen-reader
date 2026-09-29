/**
 * 翻译服务（主进程专用）。
 *
 * - 在线：免费 MyMemory HTTPS，无需 key。发送前要求
 *   `translation.onlineConsent === 'true'`，且只发送用户选中的文本（不打日志）。
 * - 离线：Transformers.js 量化 ONNX 包（Xenova/opus-mt-en-zh），显式下载、
 *   进度/取消/校验/原子落盘，推理跑在 worker 线程。
 *
 * 模型只写入用户 profile 的 translation 目录。独立 worker 入口由
 * electron-vite 打包，原生库在 electron-builder 的 asarUnpack 中配置。
 */

import { createHash } from 'node:crypto'
import { mkdir, lstat, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  TranslationResult,
  TranslationServiceDeps,
  TranslationSnapshot,
  TranslationStatus,
  PackFileEntry
} from '../shared/translation-types'
import { singleEnglishWord } from './dictionary'

/** HF 模型与固定版本（2026-09-27 经 HF API 核验，见 PACK_FILES 注释）。 */
export const MODEL_ID = 'Xenova/opus-mt-en-zh'
export const MODEL_REVISION = '046f55aec303cdee3e0318604406d4df20f1e8ea'
export const HF_ORIGIN = 'https://huggingface.co'

/** MyMemory 单句上限 500 UTF-8 字节；整次翻译上限 10000 字符。 */
export const MAX_CHUNK_BYTES = 500
export const MAX_TEXT_CHARS = 10000
export const ONLINE_TIMEOUT_MS = 15_000
export const OFFLINE_TIMEOUT_MS = 120_000

const ONLINE_BASE_URL = 'https://api.mymemory.translated.net'
const PACK_MARKER = 'pack.json'
const STAGING_DIR = '.staging'

/**
 * 离线包固定 manifest（文件名白名单 + 体积 + 校验引用）。
 *
 * 核验方式（2026-09-27，未下载大文件）：
 * `curl -sI https://huggingface.co/Xenova/opus-mt-en-zh/resolve/<REV>/<file>`
 * 取 `x-linked-size`（大文件）/ 实测下载体积（小文件）为 size，
 * 取 `x-linked-etag` 去引号为 etag。小文件 etag == git blob sha1，已用
 * `git hash-object` 交叉验证（config.json 实测一致）；XET 大文件 etag 为
 * 大文件的 64 位 LFS 引用是 SHA256，逐字节校验后才安装。
 * 合并解码器已包含带缓存的解码路径，不再下载重复权重。总包体约 117MiB。
 */
export const PACK_FILES: PackFileEntry[] = [
  { name: 'config.json', size: 1503, etag: '787a84798a695a75720fa01ad2881c8d193c45f2' },
  { name: 'generation_config.json', size: 293, etag: '015c3e06e8eac3e32e2078ba3140f246e754ae7b' },
  { name: 'tokenizer.json', size: 6380952, etag: '7106ca5b95c748f039dd9adcc13c7542b997762d' },
  { name: 'tokenizer_config.json', size: 282, etag: '5d963ba4e41e1f0926f052dd3d04678d0819f027' },
  { name: 'vocab.json', size: 1747795, etag: 'af0681e0cede876abeea5955e449a81c10e1b4bc' },
  { name: 'source.spm', size: 806435, etag: '3f695c68a3aeb685ded9a5db0865af02c986bebf' },
  { name: 'target.spm', size: 804600, etag: 'e19744e15a0f53b209fa40dbdc9e7fc4e96771cd' },
  { name: 'special_tokens_map.json', size: 74, etag: '79ae7ea5bf033de69d0055820c57885e3d377bbb' },
  { name: 'onnx/encoder_model_quantized.onnx', size: 52899742, etag: 'd3b7912bf6a9bd27e4c074c2df91d4ff3d5b4bc5f7f6c8d7cc9c805c98fbafee' },
  { name: 'onnx/decoder_model_merged_quantized.onnx', size: 60212804, etag: '023be4f841f4c47cd65fffcbaa81c0d99d7f7e0138f7ba0e03fa220a4e688aff' }
]

export const PACK_TOTAL_SIZE = PACK_FILES.reduce((sum, file) => sum + file.size, 0)

export function buildHuggingFaceUrl(name: string): string {
  assertSafeName(name)
  return `${HF_ORIGIN}/${MODEL_ID}/resolve/${MODEL_REVISION}/${name}`
}

export function utf8Length(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * 按“句子 → 词 → 字节”逐级把文本切成每块 ≤ maxBytes UTF-8 字节。
 * 块原样拼接恒等于原文（空格/换行不丢失），调用方直接把译文按 '' 连接即可。
 */
export function splitTranslationChunks(text: string, maxBytes = MAX_CHUNK_BYTES): string[] {
  if (utf8Length(text) <= maxBytes) return [text]
  const sentences = text.match(/[^.!?;…。！？；\n]*[.!?;…。！？；\n]+|[^.!?;…。！？；\n]+$/g) ?? [text]
  const chunks: string[] = []
  let current = ''
  const pushWordSplit = (sentence: string): void => {
    const words = sentence.match(/\s+|\S+\s*/g) ?? [sentence]
    for (const word of words) {
      if (utf8Length(word) > maxBytes) {
        if (current) {
          chunks.push(current)
          current = ''
        }
        chunks.push(...splitBytes(word, maxBytes))
      } else if (utf8Length(current + word) <= maxBytes) {
        current += word
      } else {
        if (current) chunks.push(current)
        current = word
      }
    }
  }
  for (const sentence of sentences) {
    if (utf8Length(sentence) > maxBytes) {
      if (current) {
        chunks.push(current)
        current = ''
      }
      pushWordSplit(sentence)
    } else if (utf8Length(current + sentence) <= maxBytes) {
      current += sentence
    } else {
      chunks.push(current)
      current = sentence
    }
  }
  if (current) chunks.push(current)
  return chunks.filter((chunk) => chunk.length > 0)
}

/** 按字节硬切（只用于无空格的超长 token），保证不从 UTF-8 续字节处断开。 */
function splitBytes(text: string, maxBytes: number): string[] {
  const buf = Buffer.from(text, 'utf8')
  const parts: string[] = []
  let offset = 0
  while (offset < buf.length) {
    let end = Math.min(offset + maxBytes, buf.length)
    while (end > offset && end < buf.length && (buf[end] & 0xc0) === 0x80) end -= 1
    if (end <= offset) end = offset + 1
    parts.push(buf.subarray(offset, end).toString('utf8'))
    offset = end
  }
  return parts
}

/** manifest 文件名必须是相对路径，不含 .. / 绝对路径 / 反斜杠。 */
function assertSafeName(name: string): void {
  if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) {
    throw new Error(`离线包文件名不在白名单内:${name}`)
  }
}

function gitBlobSha1(data: Buffer): string {
  return createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex')
}

class DownloadCancelled extends Error {
  constructor() {
    super('下载已取消')
  }
}

export function createTranslationService(deps: TranslationServiceDeps) {
  const directory = resolve(deps.directory)
  const fetchImpl = deps.fetchImpl ?? fetch
  const packFiles = deps.packFiles ?? PACK_FILES
  const onlineBase = (deps.onlineBaseUrl ?? ONLINE_BASE_URL).replace(/\/+$/, '')
  const timeoutMs = deps.timeoutMs ?? ONLINE_TIMEOUT_MS
  const total = packFiles.reduce((sum, file) => sum + file.size, 0)

  for (const file of packFiles) assertSafeName(file.name)

  let downloading = false
  let received = 0
  let lastError: string | null = null
  let disposed = false
  const shutdown = new AbortController()
  let aborter: AbortController | null = null
  let downloadPromise: Promise<TranslationSnapshot> | null = null

  const emit = (snapshot: TranslationSnapshot): void => {
    deps.onChanged(snapshot)
  }

  async function installedSize(): Promise<number | null> {
    try {
      const marker = JSON.parse(await readFile(join(directory, PACK_MARKER), 'utf8')) as {
        revision?: unknown
        files?: unknown
      }
      if (marker.revision !== MODEL_REVISION && deps.packFiles === undefined) return null
      const expected = new Map(packFiles.map((file) => [file.name, file.size]))
      if (Array.isArray(marker.files)) {
        for (const entry of marker.files as { name?: unknown; size?: unknown }[]) {
          if (typeof entry.name !== 'string' || expected.get(entry.name) !== entry.size) return null
        }
      }
      for (const file of packFiles) {
        const info = await lstat(join(directory, file.name))
        if (!info.isFile() || info.size !== file.size) return null
      }
      return total
    } catch {
      return null
    }
  }

  function baseSnapshot(status: TranslationStatus, message: string | null): TranslationSnapshot {
    return { status, received, total, message, size: total }
  }

  function snapshot(): TranslationSnapshot {
    if (downloading) return baseSnapshot('downloading', null)
    // 同步快照不能做磁盘 IO；安装态由 download/remove/translate 路径写入的
    // 内存标记 + pack.json 落盘共同维护。这里只反映内存态，磁盘真相由
    // refreshFromDisk() 在每次状态变迁后同步。
    return baseSnapshot(cachedStatus, cachedMessage)
  }

  let cachedStatus: TranslationStatus = 'not-installed'
  let cachedMessage: string | null = null

  async function refreshFromDisk(): Promise<TranslationSnapshot> {
    if (downloading) {
      const snap = baseSnapshot('downloading', null)
      cachedStatus = 'downloading'
      cachedMessage = null
      return snap
    }
    const size = await installedSize()
    // A download may start during disk IO; don't overwrite its progress with an old snapshot.
    if (downloading) return baseSnapshot('downloading', null)
    if (size !== null) {
      received = total
      cachedStatus = 'installed'
      cachedMessage = null
      lastError = null
      return baseSnapshot('installed', null)
    }
    received = 0
    if (lastError) {
      cachedStatus = 'error'
      cachedMessage = lastError
      return baseSnapshot('error', lastError)
    }
    cachedStatus = 'not-installed'
    cachedMessage = null
    return baseSnapshot('not-installed', null)
  }

  function downloadPack(): Promise<TranslationSnapshot> {
    if (disposed) return Promise.reject(new Error('翻译服务已释放'))
    if (downloadPromise) return downloadPromise
    aborter = new AbortController()
    downloadPromise = performDownload().finally(() => { downloadPromise = null })
    return downloadPromise
  }

  async function safeDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true })
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('翻译目录无效或为符号链接')
  }

  async function performDownload(): Promise<TranslationSnapshot> {
    if (disposed) throw new Error('翻译服务已释放')
    if (downloading) return snapshot()
    // 幂等：已安装则直接返回，不重新下载。
    const already = await installedSize()
    if (already !== null) {
      received = total
      lastError = null
      const snap = await refreshFromDisk()
      emit(snap)
      return snap
    }
    downloading = true
    received = 0
    const controller = aborter!
    emit(baseSnapshot('downloading', null))

    const staging = join(directory, STAGING_DIR)
    try {
      await safeDirectory(directory)
      await safeDirectory(staging)
      for (const file of packFiles) {
        if (controller.signal.aborted) throw new DownloadCancelled()
        const url = deps.packFiles === undefined ? buildHuggingFaceUrl(file.name) : file.name
        if (deps.packFiles === undefined) {
          const origin = new URL(url).origin
          if (origin !== HF_ORIGIN) throw new Error(`拒绝从非白名单来源下载:${origin}`)
        }
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)])
        const response = await fetchImpl(url, { signal })
        if (!response.ok) {
          if (response.status === 429) throw new Error(`下载 ${file.name} 被限流(HTTP 429)，请稍后重试`)
          throw new Error(`下载 ${file.name} 失败(HTTP ${response.status})`)
        }
        const data = await readResponseBytes(response, file.size, signal, (bytes) => {
          received += bytes
          emit(baseSnapshot('downloading', null))
        })
        if (data.length !== file.size) {
          throw new Error(`下载 ${file.name} 大小不符(期望 ${file.size}，实际 ${data.length})`)
        }
        const checksum = file.etag.length === 40 ? gitBlobSha1(data) : createHash('sha256').update(data).digest('hex')
        if (checksum !== file.etag) {
          throw new Error(`下载 ${file.name} 校验失败`)
        }
        const target = join(staging, file.name)
        await safeDirectory(dirname(target))
        await writeFile(target, data)
        emit(baseSnapshot('downloading', null))
      }
      // 原子落盘：staging → 正式目录，最后写 marker。
      for (const file of packFiles) {
        if (controller.signal.aborted) throw new DownloadCancelled()
        const target = join(directory, file.name)
        await safeDirectory(dirname(target))
        await rename(join(staging, file.name), target)
      }
      await writeFile(
        join(directory, `${PACK_MARKER}.tmp`),
        JSON.stringify({
          version: 1,
          modelId: MODEL_ID,
          revision: MODEL_REVISION,
          files: packFiles.map((file) => ({ name: file.name, size: file.size })),
          totalSize: total,
          installedAt: Date.now()
        })
      )
      if (controller.signal.aborted) throw new DownloadCancelled()
      await rename(join(directory, `${PACK_MARKER}.tmp`), join(directory, PACK_MARKER))
      await rm(staging, { recursive: true, force: true })
      downloading = false
      aborter = null
      lastError = null
      const snap = await refreshFromDisk()
      emit(snap)
      return snap
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {})
      await rm(join(directory, `${PACK_MARKER}.tmp`), { force: true }).catch(() => {})
      downloading = false
      aborter = null
      if (error instanceof DownloadCancelled || (error instanceof Error && (error.name === 'AbortError' || /aborted|cancel/i.test(error.message)))) {
        lastError = '下载已取消'
      } else {
        lastError = error instanceof Error ? error.message : '下载失败'
      }
      const snap = await refreshFromDisk()
      emit(snap)
      return snap
    }
  }

  function cancelDownload(): void {
    aborter?.abort()
  }

  /**
   * 只删除本服务目录内的白名单文件 + marker + staging。
   * 目录本身是符号链接时拒绝，避免删到用户别处。
   */
  async function removePack(): Promise<TranslationSnapshot> {
    cancelDownload()
    await downloadPromise
    try {
      const info = await lstat(directory)
      if (info.isSymbolicLink()) throw new Error('翻译目录是符号链接，拒绝删除')
      if (!info.isDirectory()) throw new Error('翻译目录不是文件夹，拒绝删除')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        lastError = null
        const snap = await refreshFromDisk()
        emit(snap)
        return snap
      }
      throw error
    }
    // Check nested model directory before touching children, so a symlink cannot redirect deletion.
    try { if ((await lstat(join(directory, 'onnx'))).isSymbolicLink()) throw new Error('模型目录是符号链接，拒绝删除') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const known = new Set([...packFiles.map((file) => file.name), PACK_MARKER, `${PACK_MARKER}.tmp`, STAGING_DIR])
    for (const name of known) {
      assertSafeName(name)
      await rm(join(directory, name), { recursive: true, force: true })
    }
    // onnx 空目录顺手收走（非空则保留，不误伤）。
    await rmdir(join(directory, 'onnx')).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error
    })
    lastError = null
    const snap = await refreshFromDisk()
    emit(snap)
    return snap
  }

  function readPair(): { source: string; target: string } {
    const source = deps.getSetting('translation.source') ?? 'en'
    const target = deps.getSetting('translation.target') ?? 'zh-CN'
    if (source !== 'en' || target !== 'zh-CN') {
      throw new Error(`暂仅支持英→简中翻译(当前 ${source}→${target})`)
    }
    return { source, target }
  }

  async function translate(text: string, signal?: AbortSignal): Promise<TranslationResult> {
    if (disposed) throw new Error('翻译服务已释放')
    signal = signal ? AbortSignal.any([signal, shutdown.signal]) : shutdown.signal
    if (typeof text !== 'string' || !text.trim()) throw new Error('没有可翻译的内容')
    if (text.length > MAX_TEXT_CHARS) throw new Error('一次最多翻译 10000 字，请分段翻译')
    if (signal?.aborted) throw new Error('翻译已取消')
    const { source, target } = readPair()
    const mode = deps.getSetting('translation.mode') ?? 'online'
    if (mode !== 'online' && mode !== 'offline') throw new Error(`未知的翻译模式:${mode}`)
    const word = singleEnglishWord(text)
    if (deps.lookupWord && word) {
      if (mode === 'online' && (deps.getSetting('translation.onlineConsent') ?? 'false') !== 'true') {
        throw new Error('请先同意在线查词（所选单词会发送给有道词典）')
      }
      return { text: await deps.lookupWord(word, mode, signal), engine: `${mode}-dictionary` }
    }
    if (mode === 'offline') {
      const size = await installedSize()
      if (size === null) throw new Error('离线包未安装，请先下载离线包（不会自动下载）')
      const out = await runOffline(text, signal)
      return { text: out, engine: 'offline' }
    }
    if ((deps.getSetting('translation.onlineConsent') ?? 'false') !== 'true') {
      throw new Error('请先同意在线翻译（选中文本会被发送到翻译服务），再发起翻译')
    }
    const chunks = splitTranslationChunks(text)
    const parts: string[] = []
    for (const chunk of chunks) {
      if (signal?.aborted) throw new Error('翻译已取消')
      parts.push(chunk.trim() ? await translateChunkOnline(chunk, source, target, signal) : chunk)
    }
    return { text: parts.join(''), engine: 'online' }
  }

  async function translateChunkOnline(
    chunk: string,
    source: string,
    target: string,
    signal?: AbortSignal
  ): Promise<string> {
    const params = new URLSearchParams({ q: chunk, langpair: `${source}|${target}` })
    const url = `${onlineBase}/get?${params.toString()}`
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && !(deps.onlineBaseUrl && parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1')) {
      throw new Error('在线翻译只允许 HTTPS')
    }
    const timeout = AbortSignal.timeout(timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    let response: Response
    try {
      // 只发送当前选中文本；不记录、不透出到任何日志（错误信息也不带原文）。
      response = await fetchImpl(url, { signal: combined, redirect: 'error' })
    } catch (error) {
      if (signal?.aborted) throw new Error('翻译已取消')
      if (timeout.aborted) throw new Error('在线翻译超时，请稍后重试')
      throw new Error('在线翻译网络异常，请检查网络后重试')
    }
    if (response.status === 429) throw new Error('在线翻译限流，请稍后重试')
    if (!response.ok) throw new Error(`在线翻译失败(HTTP ${response.status})`)
    let payload: unknown
    try {
      payload = JSON.parse(await response.text())
    } catch {
      throw new Error('在线翻译返回无效，请稍后重试')
    }
    return extractTranslatedText(payload)
  }

  function dispose(): void {
    disposed = true
    shutdown.abort()
    cancelDownload()
  }

  async function runOffline(text: string, signal?: AbortSignal): Promise<string> {
    // 测试注入优先；生产走 worker 线程（UI/主进程不阻塞，见 translation-worker.ts）。
    if (deps.translateOffline) {
      return deps.translateOffline(text, { modelDir: directory, signal: signal ?? AbortSignal.timeout(OFFLINE_TIMEOUT_MS) })
    }
    const workerPath = deps.workerPath ?? defaultWorkerPath()
    const { existsSync } = await import('node:fs')
    if (!existsSync(workerPath)) {
      throw new Error('离线推理 worker 未打包，请让应用正确集成 worker 文件后重试')
    }
    const { Worker } = await import('node:worker_threads')
    const timeout = AbortSignal.timeout(deps.timeoutMs ?? OFFLINE_TIMEOUT_MS)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    if (combined.aborted) throw new Error('翻译已取消')
    return new Promise<string>((resolvePromise, rejectPromise) => {
      let settled = false
      let worker: import('node:worker_threads').Worker
      try {
        worker = new Worker(workerPath)
      } catch (error) {
        rejectPromise(error instanceof Error ? error : new Error('离线推理启动失败'))
        return
      }
      const done = (error: Error | null, text = ''): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        combined.removeEventListener('abort', onAbort)
        void worker.terminate().catch(() => {})
        if (error) rejectPromise(error)
        else resolvePromise(text)
      }
      const onAbort = (): void => done(new Error(signal?.aborted ? '翻译已取消' : '离线翻译超时'))
      const timer = setTimeout(onAbort, (deps.timeoutMs ?? OFFLINE_TIMEOUT_MS) + 1000)
      combined.addEventListener('abort', onAbort, { once: true })
      worker.once('error', (error: Error) => {
        done(new Error(`离线翻译失败:${error.message}`))
      })
      worker.once('message', (message: { ok?: unknown; text?: unknown; message?: unknown }) => {
        if (message?.ok === true && typeof message.text === 'string' && message.text.trim()) done(null, message.text)
        else done(new Error(typeof message?.message === 'string' ? message.message : '离线翻译失败'))
      })
      worker.once('exit', () => { if (!settled) done(new Error('离线推理意外退出，请重试')) })
      if (combined.aborted) onAbort()
      else worker.postMessage({ type: 'translate', modelDir: directory, text })
    })
  }

  // 初始化内存快照（同步 snapshot 在磁盘就绪前不至于撒谎，由调用方按需刷新）。
  void refreshFromDisk().then((snap) => emit(snap)).catch(() => {})

  return { snapshot, downloadPack, cancelDownload, removePack, translate, dispose }
}

function defaultWorkerPath(): string {
  try {
    return join(dirname(fileURLToPath(import.meta.url)), 'translation-worker.js')
  } catch {
    return 'translation-worker.js'
  }
}

async function readResponseBytes(
  response: Response,
  expectedSize: number,
  signal: AbortSignal,
  onBytes: (bytes: number) => void
): Promise<Buffer> {
  if (!response.body) {
    const buf = Buffer.from(await response.arrayBuffer())
    if (buf.length > expectedSize) throw new Error('下载文件大小超出预期')
    onBytes(buf.length)
    return buf
  }
  const reader = response.body.getReader()
  const parts: Uint8Array[] = []
  let receivedBytes = 0
  for (;;) {
    if (signal.aborted) throw new DownloadCancelled()
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      receivedBytes += value.byteLength
      if (receivedBytes > expectedSize) {
        await reader.cancel().catch(() => {})
        throw new Error('下载文件大小超出预期')
      }
      parts.push(value)
      onBytes(value.byteLength)
    }
  }
  const merged = new Uint8Array(receivedBytes)
  let offset = 0
  for (const part of parts) {
    merged.set(part, offset)
    offset += part.byteLength
  }
  return Buffer.from(merged)
}

/** 解析 MyMemory 返回；配额/限流/无效响应一律转成明确中文错误（不回显原文）。 */
function extractTranslatedText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') throw new Error('在线翻译返回无效，请稍后重试')
  const record = payload as Record<string, unknown>
  const status = record.responseStatus
  if (record.quotaFinished === true) throw new Error('在线翻译免费额度已用完，请稍后重试')
  const details = typeof record.responseDetails === 'string' ? record.responseDetails : ''
  if (typeof status === 'number' && status !== 200) {
    if (status === 429 || /quota|limit|429/i.test(details)) {
      throw new Error('在线翻译免费额度已用完或被限流，请稍后重试')
    }
    if (/invalid/i.test(details)) throw new Error('在线翻译请求无效，请稍后重试')
    throw new Error(details ? `在线翻译失败(${details.slice(0, 80)})` : '在线翻译失败，请稍后重试')
  }
  if (typeof status === 'string' && status !== '200' && /warning|quota|limit|invalid/i.test(status + details)) {
    throw new Error('在线翻译免费额度已用完或被限流，请稍后重试')
  }
  const data = record.responseData
  if (!data || typeof data !== 'object') throw new Error('在线翻译返回无效，请稍后重试')
  const text = (data as Record<string, unknown>).translatedText
  if (typeof text !== 'string' || !text.trim()) throw new Error('在线翻译返回无效，请稍后重试')
  if (/MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID (TARGET|SOURCE|EMAIL)|NO QUERY SPECIFIED/i.test(text)) {
    if (/QUERY LENGTH/.test(text)) throw new Error('单次翻译过长，请缩短后重试')
    throw new Error('在线翻译免费额度已用完或被限流，请稍后重试')
  }
  return text
}
