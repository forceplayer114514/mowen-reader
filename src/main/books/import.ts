import { randomUUID } from 'node:crypto'
import { access, copyFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ImportedFile } from '../../shared/types'
import { booksDir, coversDir } from '../paths'

const BOOK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 由书籍 id 推导库内文件路径。id 不合法就抛错,渲染层因此无法指定任意路径。 */
export function libraryFilePath(bookId: string): string {
  if (!BOOK_ID.test(bookId)) throw new Error(`无效的书籍标识:${bookId}`)
  return join(booksDir(), `${bookId}.epub`)
}

/**
 * 把用户选中的 EPUB 复制进应用目录。
 * 每次导入生成新 id,同一本书导入两次会得到两条独立记录——
 * 判重留给上层(扫描时按源路径过滤),这里只负责复制。
 */
export async function copyEpubIntoLibrary(sourcePath: string): Promise<ImportedFile> {
  try {
    await access(sourcePath)
  } catch {
    throw new Error(`找不到文件:${sourcePath}`)
  }
  const id = randomUUID()
  const filePath = libraryFilePath(id)
  await copyFile(sourcePath, filePath)
  return { id, filePath }
}

export async function writeCover(bookId: string, bytes: Uint8Array): Promise<string> {
  const path = join(coversDir(), `${bookId}.png`)
  await writeFile(path, bytes)
  return path
}

export async function removeBookFiles(book: {
  filePath: string
  coverPath: string | null
}): Promise<void> {
  await rm(book.filePath, { force: true })
  if (book.coverPath) await rm(book.coverPath, { force: true })
}
