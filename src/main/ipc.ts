import { readFile, rm } from 'node:fs/promises'
import { basename } from 'node:path'
import { dialog, ipcMain } from 'electron'
import type { BookRecord, FinishImportInput, ImportedFile } from '../shared/types'
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
import { getSetting, setSetting } from './db/settings'
import { dbFile } from './paths'

let db: Db | null = null

function database(): Db {
  if (!db) db = openDatabase(dbFile())
  return db
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

  ipcMain.handle('settings:set', (_e, key: string, value: string): void => {
    setSetting(database(), key, value)
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
