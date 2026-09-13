import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { basename } from 'node:path'
import { dialog, ipcMain } from 'electron'
import type {
  AppendMessageInput,
  BookRecord,
  ChatDoneResult,
  ConversationRecord,
  CreateConversationInput,
  FinishImportInput,
  ImportedFile,
  MessageRecord,
  StartChatInput
} from '../shared/types'
import { discardStagedFile, libraryFilePath, removeBookFiles, writeCover } from './books/import'
import { scanFolder } from './books/scan'
import { allowSource, allowSources, assertAllowed, assertEpub } from './books/source-gate'
import { stageMany } from './books/stage'
import { openDatabase, type Db } from './db'
import {
  deleteBook,
  getBook,
  getLocations,
  insertBook,
  listBooks,
  listSourcePaths,
  setLocations,
  updateProgress
} from './db/books'
import {
  deleteConversations,
  insertConversation,
  insertMessage,
  listConversations,
  listMessages,
  updateConversationMerge
} from './db/conversations'
import { assertAllowedSettingKey, getSetting, setSetting } from './db/settings'
import { assertKeyBoundToEndpoint, assertSafeLlmEndpoint, llmEndpointHost } from './llm/endpoint'
import { streamChat } from './llm/client'
import { bindSessionLifecycle, createSessionRegistry } from './llm/session'
import { dbFile } from './paths'
import { clearApiKey, hasApiKey, readApiKey, setApiKey } from './secrets'

let db: Db | null = null

function database(): Db {
  if (!db) db = openDatabase(dbFile())
  return db
}

// 挂在模块作用域而不是 registerIpc() 内部,好让 index.ts 能在应用真正退出前
// 拿到同一份登记表去中止所有还在跑的请求——见下面的 abortAllChats()。
const sessions = createSessionRegistry()

/** 应用即将退出时调用:中止所有还在跑的模型请求。见 src/main/index.ts 的 before-quit。 */
export function abortAllChats(): void {
  sessions.abortAll()
}

export function registerIpc(): void {
  ipcMain.handle('books:list', (): BookRecord[] => listBooks(database()))

  ipcMain.handle('books:pickFiles', async (): Promise<string[]> => {
    const result = await dialog.showOpenDialog({
      title: '选择 EPUB 文件',
      filters: [{ name: 'EPUB 电子书', extensions: ['epub'] }],
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
  // 只要求路径以 .epub 结尾,就把它记进白名单,再和 stageImport 共用同一个 stageMany 去复制。
  // 残余风险的边界现在是准确的:被攻破的渲染层仍可以让本机磁盘上任意一个已经存在的、
  // 真实的 .epub 常规文件被复制进书库、读出内容;符号链接会被 stageOne 里的 lstat
  // 检查拒绝,不能再借一个 .epub 名字的符号链接读出任意文件的真实字节。前者是支持
  // 拖拽导入必须付出的代价,不是遗漏。
  ipcMain.handle(
    'books:stageDropped',
    async (_e, sourcePaths: string[]): Promise<ImportedFile[]> => {
      for (const p of sourcePaths) {
        assertEpub(p)
        allowSource(p)
      }
      return stageMany(sourcePaths)
    }
  )

  ipcMain.handle(
    'books:finishImport',
    async (_e, input: FinishImportInput): Promise<BookRecord> => {
      // coverBytes 走 ArrayBuffer 而不是 number[](见 shared/types.ts 的注释),
      // 这里用 Uint8Array 视图直接包一层,不需要逐元素转换。
      const coverPathResult = input.coverBytes
        ? await writeCover(input.id, new Uint8Array(input.coverBytes))
        : null
      const record: BookRecord = {
        id: input.id,
        title: input.title || basename(input.sourcePath, '.epub'),
        author: input.author,
        coverPath: coverPathResult,
        filePath: libraryFilePath(input.id),
        sourcePath: input.sourcePath,
        addedAt: Date.now(),
        lastReadCfi: null,
        lastReadAt: null
      }
      try {
        insertBook(database(), record)
      } catch (error) {
        // 如果 insertBook 失败,删掉已写入的封面,避免孤儿文件。直接用
        // writeCover() 已经返回的真实路径删除,不能重新用 coverPath(input.id)
        // 拼一份默认扩展名的路径去猜——真实扩展名是按封面字节的魔数推导出来的,
        // 猜错了会删不掉刚写入的那份,留下孤儿文件(两处必须用同一个路径来源)。
        // 保留原错误,不掩盖它,也不让删除失败遮挡原错误。
        if (coverPathResult) {
          try {
            await rm(coverPathResult, { force: true })
          } catch {
            // 删除封面失败不重新抛错,已有的 insertBook 错误更重要
          }
        }
        throw error
      }
      return record
    }
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

  // 刚复制进库、还没入库的文件靠这个读。路径由 id 在主进程内推导,
  // 渲染层给不出任意路径——libraryFilePath 本身就是边界。
  ipcMain.handle('books:readStaged', async (_e, id: string): Promise<ArrayBuffer> => {
    const buf = await readFile(libraryFilePath(id))
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
    await removeBookFiles(book)
    deleteBook(database(), id)
  })

  ipcMain.handle('books:saveProgress', (_e, id: string, cfi: string): void => {
    updateProgress(database(), id, cfi)
  })

  ipcMain.handle('books:getLocations', (_e, id: string): string | null =>
    getLocations(database(), id)
  )

  ipcMain.handle('books:saveLocations', (_e, id: string, json: string): void => {
    setLocations(database(), id, json)
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
    setSetting(database(), key, value)
  })

  ipcMain.handle('chat:listConversations', (_e, bookId: string) =>
    listConversations(database(), bookId)
  )

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
  ipcMain.handle('secrets:hasApiKey', () => hasApiKey())

  // 存密钥时把"此刻设置里的接口地址"一起锁进同一份密文。用户实际的填写顺序
  // 就是先地址后密钥,所以这里要求地址必须已经填好——没有地址就没有可以
  // 绑定的收件人,存下来的密钥将来只能靠"信当时的设置"来决定发给谁,那正是
  // 要堵的洞。地址本身也先过一遍安全校验,免得用户填完密钥、发起对话时才
  // 被告知地址不能用。
  ipcMain.handle('secrets:setApiKey', (_e, key: string) => {
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
    setApiKey(key, llmEndpointHost(endpoint))
  })
  ipcMain.handle('secrets:clearApiKey', () => clearApiKey())

  ipcMain.handle('chat:start', async (event, input: StartChatInput): Promise<string> => {
    const db = database()
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
    assertKeyBoundToEndpoint(stored.host, endpoint)
    const apiKey = stored.key

    const session = sessions.start()

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
        onChunk: (text) => send('chat:chunk', session.id, text)
      })
        .then(() => {
          // streamChat 对"模型正常说完"和"用户中途点了停止"一视同仁地
          // resolve,区分两者要看 AbortSignal 有没有被触发过——如果触发过,
          // 一定是 chat:abort 或者 bindSessionLifecycle 主动中止的,不是
          // 模型自己说完的。
          const result: ChatDoneResult = session.signal.aborted
            ? { status: 'stopped' }
            : { status: 'finished' }
          send('chat:done', session.id, result)
        })
        .catch((err: unknown) => {
          const result: ChatDoneResult = {
            status: 'error',
            message: err instanceof Error ? err.message : '请求失败'
          }
          send('chat:done', session.id, result)
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
