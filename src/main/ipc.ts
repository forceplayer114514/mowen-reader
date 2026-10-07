import { randomUUID } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { app, dialog, ipcMain, shell } from 'electron'
import type {
  AppendMessageInput,
  AnnotationRecord,
  CreateAnnotationInput,
  BookmarkRecord,
  BookRecord,
  ChatDoneResult,
  ConversationRecord,
  CreateBookmarkInput,
  CreateConversationInput,
  FinishImportInput,
  ImportedFile,
  MessageRecord,
  StartChatInput
} from '../shared/types'
import { supportedBookExtensions } from '../shared/book-format'
import {
  discardStagedFile,
  removeBookFiles,
  resolveStagedFile,
  stripBookExtension,
  writeCover
} from './books/import'
import { scanFolder } from './books/scan'
import { allowSource, allowSources, assertAllowed, assertSupportedBook } from './books/source-gate'
import { stageMany } from './books/stage'
import { openDatabase, type Db } from './db'
import {
  deleteBook,
  deleteBookmark,
  getBook,
  getLocations,
  insertBook,
  insertBookmark,
  listBookmarks,
  listBooks,
  listSourcePaths,
  setLocations,
  updateProgress
} from './db/books'
import {
  deleteConversations,
  getConversation,
  insertConversation,
  insertMessage,
  listAllConversations,
  listConversations,
  listMessages,
  searchConversationIds,
  updateConversationMerge,
  updateMessageContent
} from './db/conversations'
import { assertAllowedSettingKey, getSetting, setSetting } from './db/settings'
import { createAnnotation, deleteAnnotation, listAnnotations, updateAnnotation } from './db/annotations'
import { createVocab, deleteVocab, listVocab } from './db/vocab'
import type { CreateVocabInput } from '../shared/vocab-types'
import {
  assertKeyBoundToEndpoint,
  assertSafeLlmEndpoint,
  llmEndpointOrigin
} from './llm/endpoint'
import { listModels, streamChat } from './llm/client'
import { bindSessionLifecycle, createSessionRegistry } from './llm/session'
import { dbFile } from './paths'
import { clearApiKey, readApiKey, setApiKey } from './secrets'
import { abortTranslation, disposeTranslation, registerTranslationIpc } from './translation-ipc'
import { addHighlight, deleteHighlight, listHighlights } from './db/highlights'
import type { CreateHighlightInput } from '../shared/highlight-types'
import { sanitizeExcerptFilename } from '../shared/excerpts'
import { createBackup, installRestore, prepareRestore, readBackupConfig, RestoreRollbackError, writeBackupConfig } from './backup'
import { disposePdfOcr, registerPdfOcrIpc } from './pdf-ocr-ipc'
import { registerBookTranslationIpc } from './book-translation-ipc'

let db: Db | null = null
let backupBusy = false

async function withBackupLock<T>(work: () => Promise<T>): Promise<T> {
  if (backupBusy) throw new Error('已有备份或恢复操作正在进行')
  backupBusy = true
  try { return await work() } finally { backupBusy = false }
}

export function database(): Db {
  if (!db) db = openDatabase(dbFile())
  return db
}

function closeDatabase(): void {
  db?.close()
  db = null
}

// 挂在模块作用域而不是 registerIpc() 内部,好让 index.ts 能在应用真正退出前
// 拿到同一份登记表去中止所有还在跑的请求——见下面的 abortAllChats()。
const sessions = createSessionRegistry()

function annotationId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) throw new Error('注释 id 无效')
}

function annotationContent(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 20000) throw new Error('注释不能为空，且最多 20000 字')
}

/** 应用即将退出时调用:中止所有还在跑的模型请求。见 src/main/index.ts 的 before-quit。 */
export function abortAllChats(): void {
  sessions.abortAll()
  disposeTranslation()
  disposePdfOcr()
}

export async function finishBookImport(input: FinishImportInput): Promise<BookRecord> {
  // Derive the format from the actual staged file, never renderer-supplied source metadata.
  const filePath = await resolveStagedFile(input.id)
  const cover = input.coverBytes ? await writeCover(input.id, new Uint8Array(input.coverBytes)) : null
  // 标题兜底去掉三类扩展名；沿用现有 DB schema，不迁移或重写旧书籍数据。
  const record: BookRecord = {
    id: input.id, title: input.title || stripBookExtension(basename(input.sourcePath)), author: input.author,
    coverPath: cover, filePath, sourcePath: input.sourcePath,
    addedAt: Date.now(), lastReadCfi: null, lastReadAt: null, translationEnabled: false
  }
  try { insertBook(database(), record) }
  catch (error) {
    if (cover) await rm(cover, { force: true }).catch(() => {})
    throw error
  }
  return record
}

export function registerIpc(): void {
  ipcMain.handle('backup:status', () => readBackupConfig())
  ipcMain.handle('backup:chooseFolder', async () => {
    const result = await dialog.showOpenDialog({ title: '选择云同步文件夹', properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || !result.filePaths[0]) return readBackupConfig()
    const config = { folder: result.filePaths[0], lastBackup: null }
    await writeBackupConfig(config)
    return config
  })
  ipcMain.handle('backup:create', () => withBackupLock(async () => {
    const config = await readBackupConfig()
    if (!config.folder) throw new Error('请先选择 iCloud、OneDrive 或其他云同步文件夹')
    const path = await createBackup(config.folder, database())
    const updated = { ...config, lastBackup: path }
    await writeBackupConfig(updated)
    return updated
  }))
  ipcMain.handle('backup:restore', () => withBackupLock(async () => {
    const result = await dialog.showOpenDialog({ title: '选择“墨问备份-…”文件夹', properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return { restored: false }
    const stage = await prepareRestore(result.filePaths[0])
    try {
      abortAllChats()
      closeDatabase()
      await installRestore(stage)
      app.relaunch()
      app.exit(0)
      return { restored: true }
    } catch (error) {
      if (error instanceof RestoreRollbackError) {
        dialog.showErrorBox('恢复未完成', error.message)
        app.exit(1)
        throw error
      }
      // 只有真正切换数据时才关闭数据库；回滚成功后仍可继续使用原书库。
      database()
      throw error
    }
  }))
  registerTranslationIpc(database)
  registerPdfOcrIpc(database)
  registerBookTranslationIpc(database)
  ipcMain.handle('highlights:list', (_event, bookId: string) => {
    annotationId(bookId)
    return listHighlights(database(), bookId)
  })
  ipcMain.handle('highlights:add', (_event, input: CreateHighlightInput) => {
    if (!input || typeof input !== 'object') throw new Error('高光参数无效')
    annotationId(input.bookId)
    if (!getBook(database(), input.bookId)) throw new Error('书籍不存在')
    if (typeof input.startCfi !== 'string' || input.startCfi.length > 4096 || !/^epubcfi\([^,]+![^,]+\)$/.test(input.startCfi) ||
      typeof input.cfiRange !== 'string' || input.cfiRange.length > 4096 || !/^epubcfi\(.+!.+,.+,.+\)$/.test(input.cfiRange) ||
      typeof input.quote !== 'string' || !input.quote.trim() || input.quote.length > 200000) {
      throw new Error('高光原文位置无效，请重新划选')
    }
    return addHighlight(database(), input)
  })
  ipcMain.handle('highlights:delete', (_event, id: string) => { annotationId(id); deleteHighlight(database(), id) })
  ipcMain.handle('annotations:list', (_e, bookId: string): AnnotationRecord[] => {
    annotationId(bookId)
    return listAnnotations(database(), bookId)
  })
  ipcMain.handle('annotations:create', (_e, input: CreateAnnotationInput): AnnotationRecord => {
    if (!input || typeof input !== 'object') throw new Error('注释参数无效')
    annotationId(input.bookId)
    annotationContent(input.content)
    if (!getBook(database(), input.bookId)) throw new Error('书籍不存在')
    if (
      typeof input.startCfi !== 'string' || input.startCfi.length > 4096 || !/^epubcfi\([^,]+![^,]+\)$/.test(input.startCfi) ||
      typeof input.cfiRange !== 'string' || input.cfiRange.length > 4096 || !/^epubcfi\(.+!.+,.+,.+\)$/.test(input.cfiRange) ||
      typeof input.quote !== 'string' || !input.quote.trim() || input.quote.length > 200000 ||
      (input.chapterLabel !== null && (typeof input.chapterLabel !== 'string' || input.chapterLabel.length > 2000))
    ) throw new Error('注释原文位置无效，请重新划选')
    return createAnnotation(database(), { ...input, content: input.content.trim() })
  })
  ipcMain.handle('annotations:update', (_e, id: string, content: string): AnnotationRecord => {
    annotationId(id)
    annotationContent(content)
    return updateAnnotation(database(), id, content.trim())
  })
  ipcMain.handle('annotations:delete', (_e, id: string): void => {
    annotationId(id)
    deleteAnnotation(database(), id)
  })
  // 生词收藏：纯本地读写，不触碰密钥与模型通道；原文/译文来自已有的翻译结果。
  ipcMain.handle('vocab:list', (_e, bookId: string) => {
    annotationId(bookId)
    return listVocab(database(), bookId)
  })
  ipcMain.handle('vocab:add', (_e, input: CreateVocabInput) => {
    if (!input || typeof input !== 'object') throw new Error('生词参数无效')
    annotationId(input.bookId)
    if (!getBook(database(), input.bookId)) throw new Error('书籍不存在')
    if (
      typeof input.startCfi !== 'string' || input.startCfi.length > 4096 || !/^epubcfi\([^,]+![^,]+\)$/.test(input.startCfi) ||
      typeof input.cfiRange !== 'string' || input.cfiRange.length > 4096 || !/^epubcfi\(.+!.+,.+,.+\)$/.test(input.cfiRange) ||
      typeof input.sourceText !== 'string' || !input.sourceText.trim() || input.sourceText.length > 10000 ||
      typeof input.translation !== 'string' || !input.translation.trim() || input.translation.length > 20000 ||
      (input.chapterLabel !== null && (typeof input.chapterLabel !== 'string' || input.chapterLabel.length > 2000))
    ) throw new Error('生词原文位置无效，请重新翻译后收藏')
    return createVocab(database(), { ...input,
      sourceText: input.sourceText.trim(), translation: input.translation.trim() })
  })
  ipcMain.handle('vocab:delete', (_e, id: string): void => {
    annotationId(id)
    deleteVocab(database(), id)
  })
  // 摘录导出:Markdown 正文由渲染层按统一排版生成,落盘路径只取自用户在
  // 原生保存框里亲手确认的位置——渲染层传的 suggestedName 仅做默认文件名,
  // 进 dialog 前先清洗,拼不出目录穿越,也决定不了最终落点。
  ipcMain.handle('excerpts:export', async (_e, input: { suggestedName?: string; markdown?: string }): Promise<{ saved: boolean }> => {
    if (!input || typeof input !== 'object') throw new Error('导出参数无效')
    const { suggestedName, markdown } = input
    if (typeof markdown !== 'string' || !markdown.trim() || markdown.length > 2_000_000) {
      throw new Error('导出内容无效')
    }
    const base = sanitizeExcerptFilename(
      typeof suggestedName === 'string' ? suggestedName.replace(/\.md$/i, '') : ''
    )
    const result = await dialog.showSaveDialog({
      title: '导出摘录为 Markdown',
      defaultPath: `${base}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (result.canceled || !result.filePath) return { saved: false }
    await writeFile(result.filePath, markdown, 'utf-8')
    return { saved: true }
  })
  // 固定目标，不提供可被渲染层滥用的任意 URL / 本地协议打开能力。
  ipcMain.handle('books:openDownloadSite', (): Promise<void> =>
    shell.openExternal('https://z-library.bz/')
  )
  ipcMain.handle('books:list', (): BookRecord[] => listBooks(database()))

  ipcMain.handle('books:pickFiles', async (): Promise<string[]> => {
    const result = await dialog.showOpenDialog({
      title: '选择电子书文件',
      filters: [{ name: '电子书', extensions: [...supportedBookExtensions] }],
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled) return []
    allowSources(result.filePaths)
    return result.filePaths
  })

  ipcMain.handle('books:pickFolder', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      title: '选择书库文件夹',
      properties: ['openDirectory']
    })
    if (result.canceled) return null
    const dir = result.filePaths[0] ?? null
    if (dir) allowSource(dir)
    return dir
  })

  ipcMain.handle('books:scanFolder', async (_e, dir: string): Promise<string[]> => {
    const resolved = assertAllowed(dir)
    const found = await scanFolder(resolved, listSourcePaths(database()))
    allowSources(found)
    return found
  })

  ipcMain.handle(
    'books:stageImport',
    async (_e, sourcePaths: string[]): Promise<ImportedFile[]> => stageMany(sourcePaths)
  )

  // 拖拽导入的路径合法地来自渲染层本身(File 对象经 webUtils.getPathForFile 得到),
  // 天然过不了 assertAllowed 这道只认"主进程自己发出的路径"的闸门,所以单独开一条通道:
  // 只要求路径是支持的书籍格式(EPUB/PDF/TXT),就把它记进白名单,再和 stageImport
  // 共用同一个 stageMany 去复制。stageOne 里还有 lstat/常规文件/体积的二次校验。
  // 残余风险的边界现在是准确的:被攻破的渲染层仍可以让本机磁盘上任意一个已经存在的、
  // 真实的支持格式常规文件被复制进书库、读出内容;符号链接会被 stageOne 里的 lstat
  // 检查拒绝,不能再借一个书籍名字的符号链接读出任意文件的真实字节。前者是支持
  // 拖拽导入必须付出的代价,不是遗漏。
  ipcMain.handle(
    'books:stageDropped',
    async (_e, sourcePaths: string[]): Promise<ImportedFile[]> => {
      for (const p of sourcePaths) {
        assertSupportedBook(p)
        allowSource(p)
      }
      return stageMany(sourcePaths)
    }
  )

  ipcMain.handle(
    'books:finishImport',
    async (_e, input: FinishImportInput): Promise<BookRecord> => finishBookImport(input)
  )
  ipcMain.handle('books:readFile', async (_e, id: string): Promise<ArrayBuffer> => {
    const book = getBook(database(), id)
    if (!book) throw new Error(`书不存在:${id}`)
    const buf = await readFile(book.filePath)
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
  })

  // 封面走 IPC 读字节,不走 file:// URL——开发模式下渲染层跑在
  // http://localhost:5173,Chromium 不允许 http 源加载 file:// 子资源,
  // 直接用 file:// 会导致封面图一直空白。封面路径永远从数据库行里取,
  // 渲染层给的 id 换不出任意路径。
  ipcMain.handle('books:readCover', async (_e, id: string): Promise<ArrayBuffer | null> => {
    const book = getBook(database(), id)
    if (!book || !book.coverPath) return null
    const buf = await readFile(book.coverPath)
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
  })

  // 刚复制进库、还没入库的文件靠这个读。路径由 id 在主进程内按白名单扩展名推导,
  // 渲染层给不出任意路径——resolveStagedFile 本身就是边界。
  ipcMain.handle('books:readStaged', async (_e, id: string): Promise<ArrayBuffer> => {
    const buf = await readFile(await resolveStagedFile(id))
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
  })

  // 某一步导入失败时,渲染层拿这个把刚复制进库、还没入库的文件删掉,
  // 避免留下孤儿文件。复用 removeBookFiles 背后同一个 removeFile 辅助函数。
  ipcMain.handle('books:discardStaged', async (_e, id: string): Promise<void> => {
    await discardStagedFile(id)
  })

  ipcMain.handle('books:delete', async (_e, id: string): Promise<void> => {
    const book = getBook(database(), id)
    if (!book) return
    deleteBook(database(), id)
    // 先原子删除记录及级联数据；中途退出最多留下未引用文件，不留下打不开的书。
    await removeBookFiles(book).catch(() => { console.warn('已删除书籍记录，但库内文件清理失败', id) })
  })

  ipcMain.handle('books:saveProgress', (_e, id: string, cfi: string, progress = 0): void => {
    updateProgress(database(), id, cfi, progress)
  })

  ipcMain.handle('books:getLocations', (_e, id: string): string | null => {
    const cached = getLocations(database(), id)
    if (!cached) return null
    try {
      const entries: unknown = JSON.parse(cached)
      if (Array.isArray(entries) && entries.length > 0 && entries.every((value) =>
        typeof value === 'string' && /^epubcfi\(.+!.+\)$/.test(value))) return cached
    } catch { /* 可重建的索引损坏不能让整本书打不开。 */ }
    return null
  })

  ipcMain.handle('books:saveLocations', (_e, id: string, json: string): void => {
    setLocations(database(), id, json)
  })

  ipcMain.handle('bookmarks:list', (_e, bookId: string): BookmarkRecord[] => {
    if (typeof bookId !== 'string') throw new Error('书籍 id 无效')
    return listBookmarks(database(), bookId)
  })

  ipcMain.handle('bookmarks:add', (_e, input: CreateBookmarkInput): BookmarkRecord => {
    if (
      !input || typeof input.bookId !== 'string' || typeof input.startCfi !== 'string' ||
      (input.chapterLabel !== null && typeof input.chapterLabel !== 'string') ||
      typeof input.excerpt !== 'string'
    ) throw new Error('书签内容无效')
    const bookmark: BookmarkRecord = {
      id: randomUUID(),
      bookId: input.bookId,
      startCfi: input.startCfi,
      chapterLabel: input.chapterLabel,
      excerpt: input.excerpt.slice(0, 80),
      createdAt: Date.now()
    }
    insertBookmark(database(), bookmark)
    return bookmark
  })

  ipcMain.handle('bookmarks:delete', (_e, id: string): void => {
    if (typeof id !== 'string') throw new Error('书签 id 无效')
    deleteBookmark(database(), id)
  })

  ipcMain.handle('settings:get', (_e, key: string): string | null =>
    getSetting(database(), key)
  )

  // 键必须在白名单里。渲染层不该能往主进程的设置表里塞任意条目——
  // 这道闸门单独并不能挡住把 llmEndpoint 改掉(它是合法键),真正挡住那条
  // 路的是 chat:start 里的地址绑定校验,两者是两层不同的防线。
  ipcMain.handle('settings:set', (_e, key: string, value: string): void => {
    assertAllowedSettingKey(key)
    if (typeof value !== 'string') throw new Error(`设置项 ${key} 的值必须是字符串`)
    if (key === 'readingGoalMinutes' && !['0', '10', '20', '30', '60'].includes(value)) throw new Error('阅读目标无效')
    setSetting(database(), key, value)
  })

  ipcMain.handle('chat:listConversations', (_e, bookId: string) => {
    if (typeof bookId !== 'string') throw new Error('书籍 id 无效')
    return listConversations(database(), bookId)
  })

  ipcMain.handle('chat:listAllConversations', () => listAllConversations(database()))
  ipcMain.handle('chat:search', (_e, query: string): string[] => {
    if (typeof query !== 'string' || query.length > 200) throw new Error('搜索词无效')
    return searchConversationIds(database(), query)
  })

  ipcMain.handle(
    'chat:createConversation',
    (_e, input: CreateConversationInput): ConversationRecord => {
      // id 由主进程生成,不采信渲染层
      const record: ConversationRecord = {
        id: randomUUID(),
        bookId: input.bookId,
        startCfi: input.startCfi,
        endCfi: input.endCfi,
        mergedEndCfi: null,
        chapterLabel: input.chapterLabel,
        excerpt: input.excerpt.slice(0, 20),
        createdAt: Date.now()
      }
      insertConversation(database(), record)
      return record
    }
  )

  ipcMain.handle('chat:setConversationMerge', (_e, id: string, mergedEndCfi: string | null) => {
    updateConversationMerge(database(), id, mergedEndCfi)
  })

  ipcMain.handle('chat:deleteConversations', (_e, ids: string[]) => {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
      throw new Error('对话 id 无效')
    }
    deleteConversations(database(), ids)
  })

  ipcMain.handle('chat:listMessages', (_e, conversationId: string) =>
    listMessages(database(), conversationId)
  )

  ipcMain.handle('chat:appendMessage', (_e, input: AppendMessageInput): MessageRecord => {
    const record: MessageRecord = {
      id: randomUUID(),
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      quotes: input.quotes,
      createdAt: Date.now()
    }
    insertMessage(database(), record)
    return record
  })

  // 只回答有没有设过。任何返回密钥内容的通道都是违规的。
  ipcMain.handle('secrets:hasApiKey', () => {
    const endpoint = getSetting(database(), 'llmEndpoint') ?? ''
    if (!endpoint) return false
    try {
      assertSafeLlmEndpoint(endpoint)
      const stored = readApiKey()
      return stored?.origin === llmEndpointOrigin(endpoint)
    } catch {
      return false
    }
  })

  // 存密钥时把"此刻设置里的接口地址"一起锁进同一份密文。用户实际的填写顺序
  // 就是先地址后密钥,所以这里要求地址必须已经填好——没有地址就没有可以
  // 绑定的收件人,存下来的密钥将来只能靠"信当时的设置"来决定发给谁,那正是
  // 要堵的洞。地址本身也先过一遍安全校验,免得用户填完密钥、发起对话时才
  // 被告知地址不能用。
  ipcMain.handle('secrets:setApiKey', (_e, key: string) => {
    // 隔壁 settings:set 已经在做同样的检查,这里不能漏:传进来一个数字会
    // 一路写进文件,下次读出来整段信封被当成密钥、地址为空,报的却是
    // "这是旧版本存下的",把排查引向完全错误的方向。
    if (typeof key !== 'string') throw new Error('API 密钥必须是一段文字')
    // 空串是"清除密钥",清除不需要任何地址
    if (key.length === 0) {
      clearApiKey()
      return
    }
    const endpoint = getSetting(database(), 'llmEndpoint') ?? ''
    if (!endpoint) {
      throw new Error('请先在设置里填好接口地址,再填写 API 密钥——密钥会和填写时的接口地址绑定')
    }
    assertSafeLlmEndpoint(endpoint)
    setApiKey(key, llmEndpointOrigin(endpoint))
  })
  ipcMain.handle('secrets:clearApiKey', () => clearApiKey())

  ipcMain.handle('llm:listModels', async () => {
    const endpoint = getSetting(database(), 'llmEndpoint') ?? ''
    if (!endpoint) throw new Error('请先填写接口地址')
    assertSafeLlmEndpoint(endpoint)
    const stored = readApiKey()
    if (!stored) throw new Error('请先填写 API 密钥')
    assertKeyBoundToEndpoint(stored.origin, endpoint)
    return listModels({ endpoint, apiKey: stored.key })
  })

  ipcMain.handle('chat:start', async (event, input: StartChatInput): Promise<string> => {
    const db = database()
    if (input.conversationId !== undefined &&
      (typeof input.conversationId !== 'string' || !getConversation(db, input.conversationId))) {
      throw new Error('对话不存在，无法保存回答')
    }
    const endpoint = getSetting(db, 'llmEndpoint') ?? ''
    const model = getSetting(db, 'llmModel') ?? ''

    // 分开说是必须的:两者共用一句"都去填一下"的话,用户看到提示时并不知道
    // 到底是哪一项真的没填,还要自己回设置页逐个对照检查。
    if (!endpoint && !model) throw new Error('还没有配置接口地址和模型名,请先到设置里填写')
    if (!endpoint) throw new Error('还没有配置接口地址,请先到设置里填写')
    if (!model) throw new Error('还没有配置模型名,请先到设置里填写')

    // 必须在密钥被交出去之前校验地址。被攻破的渲染层能把 llmEndpoint 改成
    // 任意地址,而 https 拦不住它——证书是免费的,攻击者的地址一样可以是
    // https。所以这里是两道:协议必须安全,且这个地址必须就是当初填写密钥时
    // 的那个地址。两道任一不过都直接抛出,密钥不会被放进任何请求。
    assertSafeLlmEndpoint(endpoint)

    const stored = readApiKey()
    if (!stored) throw new Error('还没有填写 API 密钥,请先到设置里填写')
    // 地址核对放在取出 stored.key 之前:解密只是主进程内部读一下,真正
    // 危险的是把这个值交给 streamChat 去发出去,而这一步在核对之后。
    assertKeyBoundToEndpoint(stored.origin, endpoint)
    const apiKey = stored.key

    const session = sessions.start()
    let savedMessage: MessageRecord | null = null
    const persisted = (result: ChatDoneResult): ChatDoneResult => input.conversationId
      ? { ...result, savedMessage } : result

    // 生命周期中止过之后,这个 WebContents 上跑的已经不是发起这次请求的那个
    // 页面了。刷新不销毁 WebContents,isDestroyed() 仍然是 false,消息照样
    // 发得出去——而生命周期中止之后 streamChat 是正常 resolve 的,于是刷新后
    // 的新页面会收到一条它从没发起过的请求的 { status: 'stopped' }。渲染层按
    // id 过滤能忽略它,但这条消息根本不该越过页面边界。
    let lifecycleAborted = false
    const send = (channel: string, ...args: unknown[]): void => {
      if (lifecycleAborted) return
      if (!event.sender.isDestroyed()) event.sender.send(channel, ...args)
    }

    // 请求的生命周期不能长过发起它的窗口:WebContents 被销毁,或者开始一次
    // 新的导航(含刷新)时立即中止,否则请求会在没有任何界面持有它的 id 的
    // 情况下继续跑、继续计费。下面 streamChat 链路的 .finally() 里会在请求
    // 正常结束时解绑这两个监听器,长期开着的窗口不会累积用不到的监听器。
    const dispose = bindSessionLifecycle(event.sender, () => {
      lifecycleAborted = true
      sessions.abort(session.id)
    })

    // 这里不能直接调用 streamChat——必须等 chat:start 这次 invoke 的回复先
    // 送回渲染层,渲染层才知道该拿哪个 id 去匹配后面的 chat:chunk /
    // chat:done,否则一次很快失败的请求(比如 401)有可能在渲染层还没等到
    // 这次 invoke 的返回值时就先送达了 chat:done,导致界面永远对不上号、
    // 一直空等。
    //
    // setImmediate 排的是宏任务:这个 handler 从这往下到 return 之间不再有
    // 任何 await,所以这个 async 函数会同步跑到 return 语句——但即便如此,
    // 它自己返回值的 resolve、以及 Electron 内部把这个 resolve 结果转成
    // invoke 回复消息发出去的那一步,都是通过微任务完成的。宏任务一定要等
    // 当前这一轮微任务队列彻底清空之后才会被处理,所以 setImmediate 里的
    // 代码,包括它发起的 streamChat 请求,一定发生在 invoke 回复消息已经
    // 排队发出之后。而 invoke 的回复消息和 chat:chunk / chat:done 这些
    // send() 事件,走的是同一条通往这个 WebContents 的通道——同一条通道上
    // 主进程这边先发出去的消息,渲染层那边也一定按顺序先收到,不会乱序。
    // 这就保证了 id 一定先于任何 chat:chunk / chat:done 到达。
    setImmediate(() => {
      void streamChat({
        endpoint,
        model,
        apiKey,
        messages: input.messages,
        signal: session.signal,
        onChunk: (text) => {
          if (input.conversationId && text) {
            // 先同步落盘再显示；关窗、刷新或进程退出不依赖渲染层补写。
            if (!savedMessage) {
              const message: MessageRecord = { id: randomUUID(), conversationId: input.conversationId,
                role: 'assistant', content: text, quotes: [], createdAt: Date.now() }
              insertMessage(db, message)
              savedMessage = message
            } else {
              const content = savedMessage.content + text
              updateMessageContent(db, savedMessage.id, content)
              savedMessage = { ...savedMessage, content }
            }
          }
          send('chat:chunk', session.id, text, savedMessage?.id)
        }
      })
        .then(() => {
          // streamChat 对"模型正常说完"和"用户中途点了停止"一视同仁地
          // resolve,区分两者要看 AbortSignal 有没有被触发过——如果触发过,
          // 一定是 chat:abort 或者 bindSessionLifecycle 主动中止的,不是
          // 模型自己说完的。
          const result: ChatDoneResult = session.signal.aborted
            ? { status: 'stopped' }
            : { status: 'finished' }
          send('chat:done', session.id, persisted(result))
        })
        .catch((err: unknown) => {
          const result: ChatDoneResult = {
            status: 'error',
            message: err instanceof Error ? err.message : '请求失败'
          }
          send('chat:done', session.id, persisted(result))
        })
        .finally(() => {
          dispose()
          sessions.finish(session.id)
        })
    })

    return session.id
  })

  ipcMain.handle('chat:abort', (_e, requestId: string) => {
    sessions.abort(requestId)
    abortTranslation(requestId)
  })

  // 仅端到端测试使用:绕开系统文件选择框直接传入路径。
  // 这里必须先 allowSources() 再放行——stageImport 最终经 stageOne() 调用
  // assertAllowed(),只认主进程自己记过名的路径。真实的 pickFiles 通道在
  // 拿到系统对话框结果后就是这么做的,这里是它在测试环境下的等价物,
  // 不能只是原样把路径传回去,否则渲染层随后调用 stageImport 会被这道闸门拒绝。
  if (process.env.READER_E2E === '1') {
    ipcMain.handle('test:importPaths', async (_e, paths: string[]): Promise<string[]> => {
      allowSources(paths)
      return paths
    })
  }
}
