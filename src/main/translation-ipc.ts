import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { ipcMain, webContents } from 'electron'
import type { MessageRecord } from '../shared/types'
import { getConversation, insertMessage } from './db/conversations'
import { getSetting } from './db/settings'
import type { Db } from './db'
import { bindSessionLifecycle, createSessionRegistry } from './llm/session'
import { resolveDataDir } from './paths'
import { createTranslationService } from './translation'
import { createDictionaryService, formatDictionaryEntry } from './dictionary'

const requests = createSessionRegistry()
let service: ReturnType<typeof createTranslationService> | null = null
let dictionary: ReturnType<typeof createDictionaryService> | null = null

export function abortTranslation(requestId: string): void { requests.abort(requestId) }
export function disposeTranslation(): void {
  requests.abortAll()
  service?.dispose()
  dictionary?.dispose()
}

export function registerTranslationIpc(database: () => Db): void {
  dictionary = createDictionaryService({
    directory: join(resolveDataDir(), 'dictionary'),
    workerPath: join(import.meta.dirname, 'dictionary-worker.js'),
    onlineUrl: process.env.READER_E2E === '1'
      ? (process.env.READER_DICTIONARY_TEST_URL ?? (process.env.READER_TRANSLATION_TEST_URL ? `${process.env.READER_TRANSLATION_TEST_URL}/jsonapi` : undefined))
      : undefined,
    onChanged: (snapshot) => {
      for (const contents of webContents.getAllWebContents()) {
        if (!contents.isDestroyed() && contents.getType() === 'window') contents.send('dictionary:changed', snapshot)
      }
    }
  })
  const words = dictionary
  service = createTranslationService({
    directory: join(resolveDataDir(), 'translation'),
    workerPath: join(import.meta.dirname, 'translation-worker.js'),
    onlineBaseUrl: process.env.READER_E2E === '1' ? process.env.READER_TRANSLATION_TEST_URL : undefined,
    getSetting: (key) => getSetting(database(), key),
    lookupWord: async (word, mode, signal) => formatDictionaryEntry(await words.lookup(word, mode, signal)),
    onChanged: (snapshot) => {
      for (const contents of webContents.getAllWebContents()) {
        if (!contents.isDestroyed() && contents.getType() === 'window') contents.send('translation:changed', snapshot)
      }
    }
  })
  const translator = service
  ipcMain.handle('dictionary:snapshot', () => words.snapshot())
  ipcMain.handle('dictionary:download', () => { void words.download().catch(() => {}) })
  ipcMain.handle('dictionary:cancelDownload', () => words.cancel())
  ipcMain.handle('dictionary:remove', () => words.remove())
  ipcMain.handle('translation:snapshot', () => translator.snapshot())
  ipcMain.handle('translation:download', () => { void translator.downloadPack().catch(() => {}); })
  ipcMain.handle('translation:cancelDownload', () => translator.cancelDownload())
  ipcMain.handle('translation:remove', () => translator.removePack())
  ipcMain.handle('translation:start', (event, input: { text: string; conversationId?: string }): string => {
    if (!input || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 10000) {
      throw new Error('翻译原文不能为空，且最多 10000 字')
    }
    if (input.conversationId !== undefined &&
      (typeof input.conversationId !== 'string' || !getConversation(database(), input.conversationId))) {
      throw new Error('对话不存在，无法保存译文')
    }
    const request = requests.start()
    let abandoned = false
    const dispose = bindSessionLifecycle(event.sender, () => { abandoned = true; requests.abort(request.id) })
    const send = (channel: string, ...args: unknown[]): void => {
      if (!abandoned && !event.sender.isDestroyed()) event.sender.send(channel, ...args)
    }
    // Return the id before delivering events, including immediate cached/offline errors.
    setImmediate(() => {
      void translator.translate(input.text.trim(), request.signal).then((result) => {
        if (request.signal.aborted) { send('chat:done', request.id, { status: 'stopped', savedMessage: null }); return }
        const content = `〔${result.engine.startsWith('offline') ? '离线' : '在线'}${result.engine.endsWith('dictionary') ? '词典' : '翻译'}〕\n\n${result.text}`
        let savedMessage: MessageRecord | null = null
        if (input.conversationId) {
          savedMessage = { id: randomUUID(), conversationId: input.conversationId,
            role: 'assistant', content, quotes: [], createdAt: Date.now() }
          insertMessage(database(), savedMessage)
        }
        send('chat:chunk', request.id, content, savedMessage?.id)
        send('chat:done', request.id, { status: 'finished', savedMessage })
      }).catch((error: unknown) => {
        send('chat:done', request.id, request.signal.aborted
          ? { status: 'stopped', savedMessage: null }
          : { status: 'error', message: error instanceof Error ? error.message : '翻译失败，请稍后重试', savedMessage: null })
      }).finally(() => { dispose(); requests.finish(request.id) })
    })
    return request.id
  })
}
