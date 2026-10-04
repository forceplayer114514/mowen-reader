import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { CreateHighlightInput, HighlightRecord } from '../shared/highlight-types'
import type { CreateVocabInput, VocabRecord } from '../shared/vocab-types'
import type { TranslationSnapshot } from '../shared/translation-types'
import type { ReadingStats } from '../shared/reading-stats'
import type { PdfOcrInput, PdfOcrResult, PdfOcrProgress, PdfPosition } from '../shared/pdf-ocr-types'
import type {
  AppendMessageInput,
  AnnotationRecord,
  CreateAnnotationInput,
  BookmarkRecord,
  BookRecord,
  ChatDoneResult,
  ConversationRecord,
  ConversationWithBook,
  ConversationWithCount,
  CreateBookmarkInput,
  CreateConversationInput,
  FinishImportInput,
  ImportedFile,
  MessageRecord,
  OnlineBounds,
  OnlineSnapshot,
  OnlineAction,
  DownloadMetadata,
  StartChatInput
} from '../shared/types'

const api = {
  pdfOcr: (input: PdfOcrInput): Promise<PdfOcrResult> => ipcRenderer.invoke('pdf:ocr', input),
  cancelPdfOcr: (requestId: string): Promise<void> => ipcRenderer.invoke('pdf:cancelOcr', requestId),
  getPdfOcr: (bookId: string, page: number): Promise<PdfOcrResult[]> => ipcRenderer.invoke('pdf:getOcr', bookId, page),
  getPdfPosition: (bookId: string): Promise<PdfPosition | null> => ipcRenderer.invoke('pdf:getPosition', bookId),
  savePdfPosition: (bookId: string, position: PdfPosition): Promise<void> => ipcRenderer.invoke('pdf:savePosition', bookId, position),
  onPdfOcrProgress: (callback: (event: PdfOcrProgress) => void): (() => void) => {
    const listener = (_event: unknown, event: PdfOcrProgress): void => callback(event)
    ipcRenderer.on('pdf:ocrProgress', listener)
    return () => ipcRenderer.off('pdf:ocrProgress', listener)
  },
  backupStatus: (): Promise<{ folder: string | null; lastBackup: string | null }> => ipcRenderer.invoke('backup:status'),
  chooseBackupFolder: (): Promise<{ folder: string | null; lastBackup: string | null }> => ipcRenderer.invoke('backup:chooseFolder'),
  createBackup: (): Promise<{ folder: string | null; lastBackup: string | null }> => ipcRenderer.invoke('backup:create'),
  restoreBackup: (): Promise<{ restored: boolean }> => ipcRenderer.invoke('backup:restore'),
  setReadingBook: (bookId: string | null): Promise<void> => ipcRenderer.invoke('reading:book', bookId),
  readingStats: (): Promise<ReadingStats> => ipcRenderer.invoke('reading:stats'),
  onReadingStatsError: (callback: (error: string | null) => void): (() => void) => {
    const listener = (_event: unknown, error: string | null): void => callback(error)
    ipcRenderer.on('reading:error', listener)
    return () => ipcRenderer.off('reading:error', listener)
  },
  listHighlights: (bookId: string): Promise<HighlightRecord[]> => ipcRenderer.invoke('highlights:list', bookId),
  addHighlight: (input: CreateHighlightInput): Promise<HighlightRecord> => ipcRenderer.invoke('highlights:add', input),
  deleteHighlight: (id: string): Promise<void> => ipcRenderer.invoke('highlights:delete', id),
  translationSnapshot: (): Promise<TranslationSnapshot> => ipcRenderer.invoke('translation:snapshot'),
  dictionarySnapshot: (): Promise<TranslationSnapshot> => ipcRenderer.invoke('dictionary:snapshot'),
  downloadDictionary: (): Promise<void> => ipcRenderer.invoke('dictionary:download'),
  cancelDictionaryDownload: (): Promise<void> => ipcRenderer.invoke('dictionary:cancelDownload'),
  removeDictionary: (): Promise<void> => ipcRenderer.invoke('dictionary:remove'),
  onDictionaryChanged: (callback: (snapshot: TranslationSnapshot) => void): (() => void) => {
    const listener = (_event: unknown, snapshot: TranslationSnapshot): void => callback(snapshot)
    ipcRenderer.on('dictionary:changed', listener)
    return () => ipcRenderer.off('dictionary:changed', listener)
  },
  downloadTranslationPack: (): Promise<void> => ipcRenderer.invoke('translation:download'),
  cancelTranslationDownload: (): Promise<void> => ipcRenderer.invoke('translation:cancelDownload'),
  removeTranslationPack: (): Promise<void> => ipcRenderer.invoke('translation:remove'),
  startTranslation: (input: { text: string; conversationId?: string }): Promise<string> => ipcRenderer.invoke('translation:start', input),
  onTranslationChanged: (callback: (snapshot: TranslationSnapshot) => void): (() => void) => {
    const listener = (_event: unknown, snapshot: TranslationSnapshot): void => callback(snapshot)
    ipcRenderer.on('translation:changed', listener)
    return () => ipcRenderer.off('translation:changed', listener)
  },
  onlineSnapshot: (): Promise<OnlineSnapshot> => ipcRenderer.invoke('online:snapshot'),
  onlineBounds: (bounds: OnlineBounds | null): Promise<void> => ipcRenderer.invoke('online:bounds', bounds),
  onlineAction: (action: OnlineAction, approvedOrigin?: string): Promise<void> => ipcRenderer.invoke('online:action', action, approvedOrigin),
  onlineAutoImport: (value: boolean): Promise<void> => ipcRenderer.invoke('online:auto', value),
  removeDownload: (id: string): Promise<void> => ipcRenderer.invoke('online:remove', id),
  prepareDownload: (id: string): Promise<ArrayBuffer | null> => ipcRenderer.invoke('online:prepare', id),
  finishDownload: (id: string, meta: DownloadMetadata): Promise<void> => ipcRenderer.invoke('online:finish', id, meta),
  failDownload: (id: string, message: string): Promise<void> => ipcRenderer.invoke('online:fail', id, message),
  onOnlineChanged: (cb: (snapshot: OnlineSnapshot) => void): (() => void) => {
    const handler = (_event: unknown, snapshot: OnlineSnapshot): void => cb(snapshot)
    ipcRenderer.on('online:changed', handler)
    return () => ipcRenderer.off('online:changed', handler)
  },
  openDownloadSite: (): Promise<void> => ipcRenderer.invoke('books:openDownloadSite'),
  listBooks: (): Promise<BookRecord[]> => ipcRenderer.invoke('books:list'),
  pickEpubFiles: (): Promise<string[]> => ipcRenderer.invoke('books:pickFiles'),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('books:pickFolder'),
  scanFolder: (dir: string): Promise<string[]> => ipcRenderer.invoke('books:scanFolder', dir),
  stageImport: (sourcePaths: string[]): Promise<ImportedFile[]> =>
    ipcRenderer.invoke('books:stageImport', sourcePaths),
  stageDroppedFiles: (paths: string[]): Promise<ImportedFile[]> =>
    ipcRenderer.invoke('books:stageDropped', paths),
  // webUtils.getPathForFile 是 Electron 32 起替代 File.path 的方式,在
  // contextIsolation + sandbox 都开启的渲染进程里可用,但只能在 preload 里调用
  // 后经 contextBridge 转出去——渲染层自己拿不到这个模块。
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  finishImport: (input: FinishImportInput): Promise<BookRecord> =>
    ipcRenderer.invoke('books:finishImport', input),
  readBookFile: (id: string): Promise<ArrayBuffer> => ipcRenderer.invoke('books:readFile', id),
  readCover: (id: string): Promise<ArrayBuffer | null> =>
    ipcRenderer.invoke('books:readCover', id),
  readStagedFile: (id: string): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('books:readStaged', id),
  discardStagedFile: (id: string): Promise<void> =>
    ipcRenderer.invoke('books:discardStaged', id),
  deleteBook: (id: string): Promise<void> => ipcRenderer.invoke('books:delete', id),
  saveProgress: (id: string, cfi: string, progress = 0): Promise<void> =>
    ipcRenderer.invoke('books:saveProgress', id, cfi, progress),
  getLocations: (id: string): Promise<string | null> =>
    ipcRenderer.invoke('books:getLocations', id),
  saveLocations: (id: string, json: string): Promise<void> =>
    ipcRenderer.invoke('books:saveLocations', id, json),
  listBookmarks: (bookId: string): Promise<BookmarkRecord[]> =>
    ipcRenderer.invoke('bookmarks:list', bookId),
  addBookmark: (input: CreateBookmarkInput): Promise<BookmarkRecord> =>
    ipcRenderer.invoke('bookmarks:add', input),
  deleteBookmark: (id: string): Promise<void> => ipcRenderer.invoke('bookmarks:delete', id),
  listAnnotations: (bookId: string): Promise<AnnotationRecord[]> => ipcRenderer.invoke('annotations:list', bookId),
  createAnnotation: (input: CreateAnnotationInput): Promise<AnnotationRecord> => ipcRenderer.invoke('annotations:create', input),
  updateAnnotation: (id: string, content: string): Promise<AnnotationRecord> => ipcRenderer.invoke('annotations:update', id, content),
  deleteAnnotation: (id: string): Promise<void> => ipcRenderer.invoke('annotations:delete', id),
  listVocab: (bookId: string): Promise<VocabRecord[]> => ipcRenderer.invoke('vocab:list', bookId),
  addVocab: (input: CreateVocabInput): Promise<VocabRecord> => ipcRenderer.invoke('vocab:add', input),
  deleteVocab: (id: string): Promise<void> => ipcRenderer.invoke('vocab:delete', id),
  exportExcerpts: (input: { suggestedName: string; markdown: string }): Promise<{ saved: boolean }> =>
    ipcRenderer.invoke('excerpts:export', input),
  getSetting: (key: string): Promise<string | null> => ipcRenderer.invoke('settings:get', key),
  setSetting: (key: string, value: string): Promise<void> =>
    ipcRenderer.invoke('settings:set', key, value),
  // 仅端到端测试使用:主进程只在 READER_E2E=1 时注册这个通道,其余环境下调用会被拒绝。
  testImportPaths: (paths: string[]): Promise<string[]> =>
    ipcRenderer.invoke('test:importPaths', paths),

  listConversations: (bookId: string): Promise<ConversationWithCount[]> =>
    ipcRenderer.invoke('chat:listConversations', bookId),
  listAllConversations: (): Promise<ConversationWithBook[]> =>
    ipcRenderer.invoke('chat:listAllConversations'),
  searchConversations: (query: string): Promise<string[]> => ipcRenderer.invoke('chat:search', query),
  createConversation: (input: CreateConversationInput): Promise<ConversationRecord> =>
    ipcRenderer.invoke('chat:createConversation', input),
  setConversationMerge: (id: string, mergedEndCfi: string | null): Promise<void> =>
    ipcRenderer.invoke('chat:setConversationMerge', id, mergedEndCfi),
  deleteConversations: (ids: string[]): Promise<void> =>
    ipcRenderer.invoke('chat:deleteConversations', ids),
  listMessages: (conversationId: string): Promise<MessageRecord[]> =>
    ipcRenderer.invoke('chat:listMessages', conversationId),
  appendMessage: (input: AppendMessageInput): Promise<MessageRecord> =>
    ipcRenderer.invoke('chat:appendMessage', input),

  // hasApiKey 只回答有没有一份存好了、并且记下了它属于哪个接口地址的密钥,
  // 不会、也不能返回密钥内容——密钥只在主进程的 secrets 模块里存在,没有
  // 任何通道把它送出主进程。
  hasApiKey: (): Promise<boolean> => ipcRenderer.invoke('secrets:hasApiKey'),
  setApiKey: (key: string): Promise<void> => ipcRenderer.invoke('secrets:setApiKey', key),
  clearApiKey: (): Promise<void> => ipcRenderer.invoke('secrets:clearApiKey'),
  listModels: (): Promise<{ models: string[]; endpoint: string }> => ipcRenderer.invoke('llm:listModels'),

  startChat: (input: StartChatInput): Promise<string> => ipcRenderer.invoke('chat:start', input),
  abortChat: (requestId: string): Promise<void> => ipcRenderer.invoke('chat:abort', requestId),
  // 事件订阅返回取消函数,不把 ipcRenderer 的原始 event 对象透给渲染层。
  onChatChunk: (cb: (requestId: string, text: string, messageId?: string) => void): (() => void) => {
    const handler = (_e: unknown, requestId: string, text: string, messageId?: string): void => cb(requestId, text, messageId)
    ipcRenderer.on('chat:chunk', handler)
    return () => ipcRenderer.off('chat:chunk', handler)
  },
  onChatDone: (cb: (requestId: string, result: ChatDoneResult) => void): (() => void) => {
    const handler = (_e: unknown, requestId: string, result: ChatDoneResult): void =>
      cb(requestId, result)
    ipcRenderer.on('chat:done', handler)
    return () => ipcRenderer.off('chat:done', handler)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
