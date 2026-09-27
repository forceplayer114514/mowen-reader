import { randomUUID } from 'node:crypto'
import { access, copyFile, readdir, rm, lstat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { bookFormat, supportedBookExtensions, type BookFormat } from '../../shared/book-format'
import type { ImportedFile } from '../../shared/types'
import { booksDir, coversDir } from '../paths'

const BOOK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 验证书籍 id 是否为合法的 UUID。 */
function validateBookId(bookId: string): void {
  if (!BOOK_ID.test(bookId)) throw new Error(`无效的书籍标识:${bookId}`)
}

/**
 * 由书籍 id 推导库内文件路径。id 不合法就抛错,渲染层因此无法指定任意路径。
 * format 默认为 'epub',保持旧调用的兼容;PDF/TXT 导入时传入对应格式,
 * 库内文件名保留原始扩展名(原始 TXT 字节原样保留,转 EPUB 只在渲染层做)。
 */
export function libraryFilePath(bookId: string, format: string = 'epub'): string {
  validateBookId(bookId)
  const normalized = format.toLowerCase()
  if (!(supportedBookExtensions as readonly string[]).includes(normalized)) {
    throw new Error(`不支持的书籍格式:${format}`)
  }
  return join(booksDir(), `${bookId}.${normalized}`)
}

/** 去掉文件名末尾的 .epub/.pdf/.txt(大小写不敏感),供导入标题兜底使用。 */
export function stripBookExtension(name: string): string {
  return name.replace(/\.(epub|pdf|txt)$/i, '')
}

/**
 * 在库内目录里按 id 找出已暂存的文件,只认白名单内的扩展名。
 * 调用方只给 id,给不出任意路径——和 libraryFilePath 是同一道边界。
 * 找不到时抛错,让调用方走丢弃/报错流程。
 */
export async function resolveStagedFile(bookId: string): Promise<string> {
  validateBookId(bookId)
  for (const ext of supportedBookExtensions) {
    const candidate = libraryFilePath(bookId, ext)
    try {
      const info = await lstat(candidate)
      if (info.isFile() && !info.isSymbolicLink()) return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  throw new Error(`找不到已暂存文件:${bookId}`)
}

/**
 * 把用户选中的 EPUB 复制进应用目录。
 * 每次导入生成新 id,同一本书导入两次会得到两条独立记录——
 * 判重留给上层(扫描时按源路径过滤),这里只负责复制。
 * 兼容旧的 EPUB 调用;复制和失败清理仍只有一份实现。
 */
export async function copyEpubIntoLibrary(sourcePath: string): Promise<ImportedFile> {
  return copyIntoLibrary(sourcePath, 'epub')
}

/**
 * 把用户选中的 EPUB/PDF/TXT 复制进应用目录,库内文件名保留原始扩展名。
 * 格式只看扩展名推断,不读文件内容、不改 DB schema,filePath 照常持久化。
 */
export async function copyBookIntoLibrary(sourcePath: string): Promise<ImportedFile> {
  const format = bookFormat(sourcePath)
  if (!format) throw new Error(`只支持 EPUB、PDF、TXT 文件:${sourcePath}`)
  return copyIntoLibrary(sourcePath, format)
}

async function copyIntoLibrary(sourcePath: string, format: BookFormat): Promise<ImportedFile> {
  try {
    await access(sourcePath)
  } catch {
    throw new Error(`找不到文件:${sourcePath}`)
  }
  const id = randomUUID()
  const filePath = libraryFilePath(id, format)
  try { await copyFile(sourcePath, filePath) }
  catch (error) {
    await rm(filePath, { force: true }).catch(() => {})
    throw error
  }
  return { id, filePath }
}

/**
 * 由书籍 id 和扩展名推导封面文件路径。扩展名默认为 png,只在已知封面真实字节、
 * 调用 coverExtension() 算出实际格式时才会传别的值——discardStagedFile() 之类
 * 只有 id、不知道当初写入时用的是哪个扩展名的清理场景,靠的是下面 removeCover()
 * 按文件名前缀扫描目录,不依赖这个默认值猜对。
 */
export function coverPath(bookId: string, ext = 'png'): string {
  validateBookId(bookId)
  return join(coversDir(), `${bookId}.${ext}`)
}

function bytesStartWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false
  return magic.every((b, i) => bytes[i] === b)
}

/**
 * 按文件头的魔数猜封面的真实图片格式,而不是不分青红皂白地全存成 .png——
 * 之前的实现不管字节内容是什么都硬编码 .png 后缀。覆盖常见的几种格式,
 * 认不出来的字节退回 png(和这个函数出现之前的默认行为一致,不算回归)。
 */
export function coverExtension(bytes: Uint8Array): string {
  if (bytesStartWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png'
  if (bytesStartWith(bytes, [0xff, 0xd8, 0xff])) return 'jpg'
  if (bytesStartWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'gif'
  if (
    bytesStartWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes.length >= 12 &&
    bytesStartWith(bytes.subarray(8, 12), [0x57, 0x45, 0x42, 0x50])
  ) {
    return 'webp'
  }
  if (bytesStartWith(bytes, [0x42, 0x4d])) return 'bmp'
  return 'png'
}

export async function writeCover(bookId: string, bytes: Uint8Array): Promise<string> {
  const path = coverPath(bookId, coverExtension(bytes))
  await writeFile(path, bytes)
  return path
}

async function removeFile(path: string): Promise<void> {
  await rm(path, { force: true })
}

/**
 * 找到并删除封面目录里以这个 id 开头的封面文件——不管写入时用的是哪个扩展名。
 * writeCover() 按封面真实字节的魔数推导扩展名,调用方清理时(比如导入中途失败
 * 要撤销)未必知道当初选中的是哪一个,不能像 libraryFilePath 那样直接拼出唯一
 * 确定的路径,只能按文件名前缀在目录里找。目录本身不存在或读取失败时当作没有
 * 封面处理,不抛错——清理动作不应该因为这个失败。
 */
async function removeCoverIfAny(bookId: string): Promise<void> {
  validateBookId(bookId)
  let names: string[]
  try {
    names = await readdir(coversDir())
  } catch {
    return
  }
  const prefix = `${bookId}.`
  await Promise.all(
    names.filter((name) => name.startsWith(prefix)).map((name) => removeFile(join(coversDir(), name)))
  )
}

export async function removeBookFiles(book: {
  filePath: string
  coverPath: string | null
}): Promise<void> {
  await removeFile(book.filePath)
  if (book.coverPath) await removeFile(book.coverPath)
}

/**
 * 导入某一步失败时,把已经复制进库、但还没写数据库记录的那份文件删掉。
 * 只按 id 删除白名单扩展名内的库内文件,不接受渲染层传任意路径。
 * 封面路径未必知道真实扩展名,所以用 removeCoverIfAny() 按前缀查找,
 * 不能假设成 .png(否则真实格式不是 png 时会漏删,留下孤儿文件)。
 */
export async function discardStagedFile(id: string): Promise<void> {
  validateBookId(id)
  await Promise.all(
    supportedBookExtensions.map((ext) => removeFile(libraryFilePath(id, ext)))
  )
  await removeCoverIfAny(id)
}
