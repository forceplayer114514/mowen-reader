import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { dialog, ipcMain } from 'electron'
import type { BookRecord, FinishImportInput, ImportedFile } from '../shared/types'
import { copyEpubIntoLibrary, removeBookFiles, writeCover } from './books/import'
import { scanFolder } from './books/scan'
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
import { booksDir, dbFile } from './paths'

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
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('books:pickFolder', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      title: '选择书库文件夹',
      properties: ['openDirectory']
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle('books:scanFolder', (_e, dir: string): Promise<string[]> =>
    scanFolder(dir, listSourcePaths(database()))
  )

  ipcMain.handle(
    'books:stageImport',
    async (_e, sourcePaths: string[]): Promise<ImportedFile[]> => {
      const out: ImportedFile[] = []
      for (const p of sourcePaths) out.push(await copyEpubIntoLibrary(p))
      return out
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
        filePath: input.filePath,
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

  // 刚复制进库、还没入库的文件靠这个读。路径必须落在书库目录内,
  // 否则等于把任意文件读取权开放给了渲染层。
  ipcMain.handle('books:readStaged', async (_e, filePath: string): Promise<ArrayBuffer> => {
    const root = booksDir()
    const full = resolve(filePath)
    if (!full.startsWith(root)) throw new Error('路径不在书库目录内')
    const buf = await readFile(full)
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
