import { ipcMain } from 'electron'
import {
  batchSegments,
  MAX_BOOK_PAGE_CHARS,
  MAX_SEGMENTS_PER_ENSURE,
  MAX_SEGMENT_BATCH_CHARS,
  normalizeBookText
} from '../shared/book-translation'
import type { Db } from './db'
import { getBook, getTranslationEnabled, setTranslationEnabled } from './db/books'
import { countBookSegments, getBookSegments, saveBookSegments, segHashOf } from './db/book-segments'
import { getSetting } from './db/settings'
import {
  formatNumberedRequest,
  parseNumberedTranslations,
  TRANSLATE_STRICT_PROMPT,
  TRANSLATE_SYSTEM_PROMPT
} from './book-segments'
import { streamChat } from './llm/client'
import { assertKeyBoundToEndpoint, assertSafeLlmEndpoint, llmEndpointOrigin } from './llm/endpoint'
import { readApiKey } from './secrets'

const TRANSLATE_TIMEOUT_MS = 60_000

export interface EnsureSegmentsResult {
  /** 与输入分句一一对齐的译文（顺序一致，空分句对应空串）。 */
  translations: string[]
  /** 本次实际调用模型新翻译的分句数（0 表示全部命中缓存）。 */
  translatedNow: number
}

function requireLlm(db: Db): { endpoint: string; model: string; apiKey: string } {
  const endpoint = getSetting(db, 'llmEndpoint') ?? ''
  const model = getSetting(db, 'llmModel') ?? ''
  if (!endpoint && !model) throw new Error('还没有配置接口地址和模型名，请先到设置里填写 AI 模型')
  if (!endpoint) throw new Error('还没有配置接口地址，请先到设置里填写 AI 模型')
  if (!model) throw new Error('还没有配置模型名，请先到设置里填写 AI 模型')
  assertSafeLlmEndpoint(endpoint)
  const stored = readApiKey()
  if (!stored) throw new Error('还没有填写 API 密钥，请先到设置里填写 AI 模型')
  assertKeyBoundToEndpoint(stored.origin, endpoint)
  return { endpoint, model, apiKey: stored.key }
}

/** 一批分句一次模型调用：编号去、编号回，对不齐则换更严格的提示重试一次。 */
async function translateBatch(
  llm: { endpoint: string; model: string; apiKey: string },
  batch: string[]
): Promise<string[]> {
  const request = formatNumberedRequest(batch)
  const run = async (system: string): Promise<string[] | null> => {
    let collected = ''
    await streamChat({
      endpoint: llm.endpoint,
      model: llm.model,
      apiKey: llm.apiKey,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: request }
      ],
      signal: AbortSignal.timeout(TRANSLATE_TIMEOUT_MS),
      onChunk: (text) => {
        collected += text
      }
    })
    return parseNumberedTranslations(collected, batch.length)
  }
  const first = await run(TRANSLATE_SYSTEM_PROMPT)
  if (first) return first
  const second = await run(TRANSLATE_STRICT_PROMPT)
  if (second) return second
  throw new Error('AI 返回的段落数量不符，请稍后重试')
}

export function registerBookTranslationIpc(database: () => Db): void {
  ipcMain.handle('books:getTranslationEnabled', (_e, id: string): boolean => {
    if (typeof id !== 'string' || !id) throw new Error('书籍 id 无效')
    if (!getBook(database(), id)) throw new Error('书籍不存在')
    return getTranslationEnabled(database(), id)
  })

  ipcMain.handle('books:setTranslationEnabled', (_e, id: string, enabled: boolean): boolean => {
    if (typeof id !== 'string' || !id) throw new Error('书籍 id 无效')
    if (typeof enabled !== 'boolean') throw new Error('开关值无效')
    if (!getBook(database(), id)) throw new Error('书籍不存在')
    setTranslationEnabled(database(), id, enabled)
    return enabled
  })

  ipcMain.handle('book-segments:count', (_e, bookId: string): number => {
    if (!getBook(database(), bookId)) throw new Error('书籍不存在')
    return countBookSegments(database(), bookId)
  })

  ipcMain.handle(
    'book-segments:ensure',
    async (_e, bookId: string, segments: string[]): Promise<EnsureSegmentsResult> => {
      const db = database()
      if (!getBook(db, bookId)) throw new Error('书籍不存在')
      if (!getTranslationEnabled(db, bookId)) {
        throw new Error('本书的 AI 翻译尚未开启，请先在书架上为本书开启翻译')
      }
      if (!Array.isArray(segments) || segments.length === 0 || segments.length > MAX_SEGMENTS_PER_ENSURE) {
        throw new Error('待翻译分句无效')
      }
      const normalized = segments.map((s) => (typeof s === 'string' ? normalizeBookText(s) : ''))
      // 整页上限：与划词翻译一致，避免超大页面一次性计费过多。
      const total = normalized.join('').length
      if (total === 0) throw new Error('本页没有可翻译的文字')
      if (total > MAX_BOOK_PAGE_CHARS) {
        throw new Error('本页文字过多（超过 10000 字），请调大字号使单页变短后重试')
      }
      for (const s of normalized) {
        if (s.length > 2000) throw new Error('存在过长分句，请稍后重试')
      }

      // 记号检查：缓存行存在即已翻译，直接复用，不调模型。
      const hashes = normalized.map((s) => (s ? segHashOf(bookId, s) : ''))
      const cached = getBookSegments(
        db,
        bookId,
        hashes.filter((h) => h)
      )
      const missingIndexes: number[] = []
      const missingSegments: string[] = []
      const seen = new Set<string>()
      normalized.forEach((s, i) => {
        if (!s || cached.has(hashes[i])) return
        if (seen.has(hashes[i])) return
        seen.add(hashes[i])
        missingIndexes.push(i)
        missingSegments.push(s)
      })
      if (missingSegments.length > 0) {
        const llm = requireLlm(db)
        const engineTag = `ai:${llmEndpointOrigin(llm.endpoint)}:${llm.model}`.slice(0, 200)
        // 已完成的分批即时落盘：后一批失败不影响前一批的缓存。
        for (const batch of batchSegments(missingSegments, MAX_SEGMENT_BATCH_CHARS)) {
          const translated = await translateBatch(llm, batch)
          saveBookSegments(
            db,
            batch.map((sourceText, i) => ({ bookId, sourceText, translatedText: translated[i], engine: engineTag }))
          )
        }
        // 批量写入后统一重读，保证返回与库一致（含并发写入的覆盖）。
        const fresh = getBookSegments(db, bookId, missingSegments.map((s) => segHashOf(bookId, s)))
        for (const [hash, record] of fresh) cached.set(hash, record)
      }
      const translations = normalized.map((s, i) => {
        if (!s) return ''
        const record = cached.get(hashes[i])
        if (!record) throw new Error('译文组装失败，请稍后重试')
        return record.translatedText
      })
      return { translations, translatedNow: missingSegments.length }
    }
  )
}
