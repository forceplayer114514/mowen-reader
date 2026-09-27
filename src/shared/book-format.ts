/** 本地导入支持的书籍格式。格式只看文件扩展名推断,不读文件内容、不改 DB schema。 */
export type BookFormat = 'epub' | 'pdf' | 'txt'

/** 文件选择器/文件夹扫描/拖拽导入共用的白名单,保持三处入口一致。 */
export const supportedBookExtensions: readonly BookFormat[] = ['epub', 'pdf', 'txt']

/** 各格式的体积上限:EPUB/PDF 64MB,TXT 16MB。 */
export const maxBookBytes: Record<BookFormat, number> = {
  epub: 64 * 1024 * 1024,
  pdf: 64 * 1024 * 1024,
  txt: 16 * 1024 * 1024
}

/**
 * 按文件扩展名推断书籍格式,大小写不敏感。
 * 不支持的扩展名、无扩展名、末尾是点的文件都返回 null。
 * `book.epub.txt` 按最后一段算作 txt,和扫描/导入的判定一致。
 */
export function bookFormat(path: string): BookFormat | null {
  const lower = path.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot < 0 || dot === lower.length - 1) return null
  const ext = lower.slice(dot + 1)
  if (ext === 'epub' || ext === 'pdf' || ext === 'txt') return ext
  return null
}
