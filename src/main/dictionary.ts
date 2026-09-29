import { createHash } from 'node:crypto'
import { lstat, mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import type { TranslationSnapshot } from '../shared/translation-types'

export const DICTIONARY_SOURCE = 'ECDICT'
export const DICTIONARY_BYTES = 65_933_428
export const DICTIONARY_SHA = 'c4ade63ea08cf39d9c3475e96929036d64d94c94'
export const DICTIONARY_URL = 'https://raw.githubusercontent.com/skywind3000/ECDICT/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8/ecdict.csv'
const ONLINE_URL = 'https://dict.youdao.com/jsonapi'

export interface DictionaryEntry {
  word: string
  phonetic: string
  senses: string[]
  engine: 'online' | 'offline'
}

export function singleEnglishWord(text: string): string | null {
  const word = text.trim().replace(/^[“”‘’"([{]+|[.,!?;:…“”‘’"')\]}]+$/g, '').replace(/’/g, "'")
  return /^[A-Za-z]+(?:['’-][A-Za-z]+)*$/.test(word) ? word : null
}

export function isSingleEnglishWord(text: string): boolean {
  return singleEnglishWord(text) !== null
}

export function splitSenses(text: string): string[] {
  return [...new Set(text.split(/(?:\\n|\n|；|;)+/).map((part) => part.trim()).filter(Boolean))].slice(0, 16)
}

export function formatDictionaryEntry(entry: DictionaryEntry): string {
  const phonetic = entry.phonetic ? ` /${entry.phonetic.replace(/^\/+|\/+$/g, '')}/` : ''
  return `**${entry.word}**${phonetic}\n\n${entry.senses.map((sense, index) => `${index + 1}. ${sense}`).join('\n')}`
}

export function parseOnlineDictionary(payload: unknown, word: string): DictionaryEntry {
  const item = (payload as { ec?: { word?: unknown[] } } | null)?.ec?.word?.[0] as {
    usphone?: unknown; ukphone?: unknown; trs?: Array<{ tr?: Array<{ l?: { i?: unknown } }> }>
  } | undefined
  const raw = item?.trs?.flatMap((part) => part.tr?.flatMap((tr) => Array.isArray(tr.l?.i) ? tr.l.i : []) ?? []) ?? []
  const senses = raw.filter((value): value is string => typeof value === 'string').flatMap(splitSenses).slice(0, 16)
  if (!senses.length) throw new Error('在线词典未收录该单词')
  return { word, phonetic: typeof item?.usphone === 'string' ? item.usphone : typeof item?.ukphone === 'string' ? item.ukphone : '', senses, engine: 'online' }
}

interface Deps {
  directory: string
  workerPath: string
  onChanged: (snapshot: TranslationSnapshot) => void
  fetchImpl?: typeof fetch
  /** Tests only: production downloads the pinned ECDICT file. */
  source?: { url: string; bytes: number; sha: string }
  /** Tests only. */
  onlineUrl?: string
}

export function createDictionaryService(deps: Deps) {
  const source = deps.source ?? { url: DICTIONARY_URL, bytes: DICTIONARY_BYTES, sha: DICTIONARY_SHA }
  const fetchImpl = deps.fetchImpl ?? fetch
  const path = join(deps.directory, 'ecdict.sqlite')
  const stagingCsv = join(deps.directory, 'ecdict.csv.download')
  const stagingDb = join(deps.directory, 'ecdict.sqlite.download')
  let status: TranslationSnapshot['status'] = 'not-installed'
  let received = 0
  let message: string | null = null
  let aborter: AbortController | null = null
  let worker: Worker | null = null
  let pending: Promise<void> | null = null

  const snapshot = (): TranslationSnapshot => ({ status, received, total: source.bytes, size: source.bytes, message })
  const emit = (): void => deps.onChanged(snapshot())
  const installed = async (): Promise<boolean> => {
    try { return (await stat(path)).isFile() } catch { return false }
  }
  void installed().then((yes) => { if (!pending) { status = yes ? 'installed' : 'not-installed'; emit() } })

  async function lookup(word: string, mode: 'online' | 'offline', signal?: AbortSignal): Promise<DictionaryEntry> {
    const normalized = singleEnglishWord(word)
    if (!normalized) throw new Error('词典只支持单个英文单词')
    word = normalized
    if (mode === 'offline') {
      if (!(await installed())) throw new Error('离线词典未安装，请先在设置中下载词典')
      const db = new DatabaseSync(path, { readOnly: true })
      try {
        const row = db.prepare('SELECT word, phonetic, translation FROM entries WHERE word = ?').get(word) as
          { word: string; phonetic: string; translation: string } | undefined
        if (!row) throw new Error('离线词典未收录该单词')
        return { word: row.word, phonetic: row.phonetic, senses: splitSenses(row.translation), engine: 'offline' }
      } finally { db.close() }
    }
    const url = `${deps.onlineUrl ?? ONLINE_URL}?${new URLSearchParams({ q: word })}`
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && !(deps.onlineUrl && parsed.hostname === '127.0.0.1')) throw new Error('在线词典只允许 HTTPS')
    const timeout = AbortSignal.timeout(15_000)
    let response: Response
    try { response = await fetchImpl(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error' }) }
    catch {
      if (signal?.aborted) throw new Error('翻译已取消')
      throw new Error(timeout.aborted ? '在线词典超时，请稍后重试' : '在线词典网络异常，请检查网络后重试')
    }
    if (!response.ok) throw new Error(`在线词典失败(HTTP ${response.status})`)
    const body = await response.text()
    if (body.length > 1_000_000) throw new Error('在线词典返回内容过大')
    try { return parseOnlineDictionary(JSON.parse(body), word) }
    catch (error) { if (error instanceof SyntaxError) throw new Error('在线词典返回无效'); throw error }
  }

  function download(): Promise<void> {
    if (pending) return pending
    pending = performDownload().catch((error) => {
      status = 'error'; message = error instanceof Error ? error.message : '词典下载失败'; emit()
    }).finally(() => { pending = null })
    return pending
  }

  async function performDownload(): Promise<void> {
    if (await installed()) { status = 'installed'; received = source.bytes; message = null; emit(); return }
    await mkdir(deps.directory, { recursive: true })
    if ((await lstat(deps.directory)).isSymbolicLink()) throw new Error('词典目录不能是符号链接')
    status = 'downloading'; received = 0; message = null; emit()
    aborter = new AbortController()
    try {
      const response = await fetchImpl(source.url, { signal: aborter.signal, redirect: 'error' })
      if (!response.ok || !response.body) throw new Error(`词典下载失败(HTTP ${response.status})`)
      const hash = createHash('sha1').update(`blob ${source.bytes}\0`)
      const file = await open(stagingCsv, 'w')
      try {
        const reader = response.body.getReader()
        for (;;) {
          const { done, value: chunk } = await reader.read()
          if (done) break
          if (!chunk) continue
          if (aborter.signal.aborted) throw new Error('下载已取消')
          received += chunk.byteLength
          if (received > source.bytes) throw new Error('词典下载大小不符')
          hash.update(chunk)
          let offset = 0
          while (offset < chunk.byteLength) {
            const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset)
            if (!bytesWritten) throw new Error('词典写入失败')
            offset += bytesWritten
          }
          emit()
        }
      } finally { await file.close() }
      if (received !== source.bytes || hash.digest('hex') !== source.sha) throw new Error('词典下载校验失败')
      if (aborter.signal.aborted) throw new Error('下载已取消')
      await new Promise<void>((resolve, reject) => {
        worker = new Worker(deps.workerPath, { workerData: { csv: stagingCsv, database: stagingDb } })
        worker.once('message', (result: { ok: boolean; message?: string }) => result.ok ? resolve() : reject(new Error(result.message ?? '词典导入失败')))
        worker.once('error', reject)
        worker.once('exit', (code) => { if (code !== 0) reject(new Error('词典导入已中断')) })
      })
      worker = null
      if (aborter.signal.aborted) throw new Error('下载已取消')
      await rename(stagingDb, path)
      status = 'installed'; message = null; emit()
    } catch (error) {
      status = 'error'; message = aborter?.signal.aborted ? '下载已取消' : error instanceof Error ? error.message : '词典下载失败'; emit()
    } finally {
      if (worker) { await worker.terminate().catch(() => {}); worker = null }
      await rm(stagingCsv, { force: true }).catch(() => {})
      await rm(stagingDb, { force: true }).catch(() => {})
      aborter = null
    }
  }

  function cancel(): void { aborter?.abort(); void worker?.terminate() }
  async function remove(): Promise<TranslationSnapshot> {
    cancel()
    await pending
    try {
      if ((await lstat(deps.directory)).isSymbolicLink()) throw new Error('词典目录不能是符号链接')
      await rm(path, { force: true })
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    status = 'not-installed'; received = 0; message = null; emit()
    return snapshot()
  }
  function dispose(): void { cancel() }
  return { snapshot, lookup, download, cancel, remove, dispose }
}
