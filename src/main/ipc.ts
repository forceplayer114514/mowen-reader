import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { dialog, ipcMain } from 'electron'
import type { BookRecord, FinishImportInput, ImportedFile } from '../shared/types'
import { libraryFilePath, removeBookFiles, writeCover } from './books/import'
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
  // 残余风险是清楚的:被攻破的渲染层仍可以让本机磁盘上任意一个已存在的 .epub 文件
  // 被复制进书库、读出内容——这是支持拖拽导入必须付出的代价,不是遗漏。
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
      const coverPath = input.coverBytes
        ? await writeCover(input.id, Uint8Array.from(input.coverBytes))
        : null
      const record: BookRecord = {
        id: input.id,
        title: input.title || basename(input.sourcePath, '.epub'),
        author: input.author,
        coverPath,
        filePath: libraryFilePath(input.id),
        sourcePath: input.sourcePath,
        addedAt: Date.now(),
        lastReadCfi: null,
        lastReadAt: null
      }
      insertBook(database(), record)
      return record
    }
  )

  ipcMain.handle('books:readFile', async (_e, id: string): Promise<ArrayBuffer> => {
    const book = getBook(database(), id)
    if (!book) throw new Error(`书不存在:${id}`)
    const buf = await readFile(book.filePath)
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
  })

  // 刚复制进库、还没入库的文件靠这个读。路径由 id 在主进程内推导,
  // 渲染层给不出任意路径——libraryFilePath 本身就是边界。
  ipcMain.handle('books:readStaged', async (_e, id: string): Promise<ArrayBuffer> => {
    const buf = await readFile(libraryFilePath(id))
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
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
}
