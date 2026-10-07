import { ipcMain } from 'electron'
import { MAX_BOOK_PAGE_CHARS, type BookTranslationRecord } from '../shared/book-translation'
import type { Db } from './db'
import { getBook, getTranslationEnabled, setTranslationEnabled } from './db/books'
import {
  countBookTranslations,
  getBookTranslation,
  saveBookTranslation
} from './db/book-translations'
import { getSetting } from './db/settings'
import { streamChat } from './llm/client'
import { assertKeyBoundToEndpoint, assertSafeLlmEndpoint, llmEndpointOrigin } from './llm/endpoint'
import { readApiKey } from './secrets'

const TRANSLATE_TIMEOUT_MS = 60_000

const SYSTEM_PROMPT =
  '你是书籍翻译助手。将用户提供的书籍正文翻译成简体中文。保持段落换行与标点，只输出译文，不要解释、不要加前后缀。如果原文已经是简体中文，直接返回原文。'

function assertPageKey(pageKey: unknown): asserts pageKey is string {
  if (typeof pageKey !== 'string' || !pageKey || pageKey.length > 4096) throw new Error('翻译页键无效')
  if (!pageKey.startsWith('pdf-page-') && !pageKey.startsWith('epub-')) throw new Error('翻译页键无效')
}

function assertSourceText(text: unknown): asserts text is string {
  if (typeof text !== 'string' || !text.trim()) throw new Error('本页没有可翻译的文字')
  if (text.length > MAX_BOOK_PAGE_CHARS) {
    throw new Error('本页文字过多（超过 10000 字），请调大字号使单页变短后重试')
  }
}

async function translateWithLlm(sourceText: string, db: Db): Promise<{ text: string; engine: string }> {
  const endpoint = getSetting(db, 'llmEndpoint') ?? ''
  const model = getSetting(db, 'llmModel') ?? ''
  if (!endpoint && !model) throw new Error('还没有配置接口地址和模型名，请先到设置里填写 AI 模型')
  if (!endpoint) throw new Error('还没有配置接口地址，请先到设置里填写 AI 模型')
  if (!model) throw new Error('还没有配置模型名，请先到设置里填写 AI 模型')
  assertSafeLlmEndpoint(endpoint)
  const stored = readApiKey()
  if (!stored) throw new Error('还没有填写 API 密钥，请先到设置里填写 AI 模型')
  assertKeyBoundToEndpoint(stored.origin, endpoint)

  let collected = ''
  await streamChat({
    endpoint,
    model,
    apiKey: stored.key,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: sourceText }
    ],
    signal: AbortSignal.timeout(TRANSLATE_TIMEOUT_MS),
    onChunk: (text) => {
      collected += text
    }
  })
  const out = collected.trim()
  if (!out) throw new Error('AI 没有返回译文，请稍后重试')
  // 流式模型偶尔会在结尾补一句解释，截断到合理长度后仍保留全文。
  if (out.length > 40000) throw new Error('AI 返回的译文过长，请调大字号使单页变短后重试')
  return { text: out, engine: `ai:${llmEndpointOrigin(endpoint)}:${model}`.slice(0, 200) }
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

  ipcMain.handle(
    'book-translation:get',
    (_e, bookId: string, pageKey: string): BookTranslationRecord | null => {
      if (!getBook(database(), bookId)) throw new Error('书籍不存在')
      assertPageKey(pageKey)
      return getBookTranslation(database(), bookId, pageKey)
    }
  )

  ipcMain.handle('book-translation:count', (_e, bookId: string): number => {
    if (!getBook(database(), bookId)) throw new Error('书籍不存在')
    return countBookTranslations(database(), bookId)
  })

  ipcMain.handle(
    'book-translation:translate',
    async (_e, bookId: string, pageKey: string, sourceText: string): Promise<BookTranslationRecord> => {
      const db = database()
      const book = getBook(db, bookId)
      if (!book) throw new Error('书籍不存在')
      assertPageKey(pageKey)
      assertSourceText(sourceText)
      if (!getTranslationEnabled(db, bookId)) {
        throw new Error('本书的 AI 翻译尚未开启，请先在书架上为本书开启翻译')
      }
      const normalized = sourceText.replace(/\s+/g, ' ').trim()
      // 缓存优先：同一页、同一原文直接复用，不再计费；排版变化导致正文变化时重新翻译并更新。
      const cached = getBookTranslation(db, bookId, pageKey)
      if (cached && cached.sourceText.replace(/\s+/g, ' ').trim() === normalized) return cached
      const { text, engine } = await translateWithLlm(sourceText.trim(), db)
      return saveBookTranslation(db, {
        bookId,
        pageKey,
        sourceText: sourceText.trim(),
        translatedText: text,
        engine
      })
    }
  )
}
