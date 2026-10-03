import JSZip from 'jszip'
import { crc32, createInflateRaw } from 'node:zlib'
import { bookFormat } from '../../shared/book-format'
import { decodeText } from '../../shared/book-text'

export async function validateDownloadedBook(bytes: Buffer, filename: string): Promise<void> {
  const format = bookFormat(filename)
  if (!format) throw new Error('仅支持 EPUB、PDF 或 TXT')
  if (format === 'epub') return validateDownloadedEpub(bytes)
  if (format === 'txt') {
    decodeText(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
  } else if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-')) || !bytes.subarray(-2048).includes(Buffer.from('%%EOF'))) {
    throw new Error('下载文件不是完整 PDF（可能是登录或错误页面）')
  }
  // PDF structure/passwords are checked by PDF.js before finishDownload can commit it.
}

// Bound the central directory before JSZip allocates its entry table.
// ZIP64/spanned archives require a different parser and remain unsupported.
function checkEntryCount(bytes: Buffer): void {
  const signature = Buffer.from([0x50, 0x4b, 0x05, 0x06])
  let end = bytes.lastIndexOf(signature)
  while (end >= 0 && (end + 22 > bytes.length || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length)) {
    end = end === 0 ? -1 : bytes.lastIndexOf(signature, end - 1)
  }
  if (end < Math.max(0, bytes.length - 65557) || end < 0) throw new Error('EPUB ZIP 目录损坏')
  const count = bytes.readUInt16LE(end + 10)
  if (count > 2000) throw new Error('EPUB 文件数量过多')
  if (bytes.readUInt32LE(end + 4) !== 0 || bytes.readUInt16LE(end + 8) !== count) throw new Error('不支持分卷 EPUB')
  let offset = bytes.readUInt32LE(end + 16)
  if (offset + bytes.readUInt32LE(end + 12) !== end) throw new Error('EPUB ZIP 目录损坏')
  let actual = 0
  while (offset < end) {
    if (++actual > 2000) throw new Error('EPUB 文件数量过多')
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('EPUB ZIP 目录损坏')
    offset += 46 + bytes.readUInt16LE(offset + 28) + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32)
  }
  if (offset !== end || actual !== count) throw new Error('EPUB ZIP 目录损坏')
}

/** Verify each resource without retaining its decompressed contents in memory. */
export async function validateDownloadedEpub(bytes: Buffer): Promise<void> {
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) throw new Error('下载文件不是 EPUB（可能是登录或错误页面）')
  checkEntryCount(bytes)
  const zip = await JSZip.loadAsync(bytes)
  const entries = Object.values(zip.files)
  if (entries.length > 2000) throw new Error('EPUB 文件数量过多')
  for (const entry of entries) {
    const original = entry.unsafeOriginalName || entry.name
    if (/^[\\/]|(^|[\\/])\.\.([\\/]|$)|\0/.test(original)) throw new Error('EPUB 包含不安全路径')
    if (entry.dir) continue
    // ponytail: JSZip 3.x exposes central-directory sizes on _data; recheck on a major upgrade.
    const data = (entry as unknown as { _data: { uncompressedSize: number; crc32: number; compressedContent: Uint8Array; compression: { magic: string } } })._data
    // JSZip normalizes zero-size files to a resolved empty-data promise, not CompressedObject.
    if (data instanceof Promise && (await data).length === 0) continue
    const size = data.uncompressedSize
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('EPUB 内容大小无效')
    let length = 0
    let checksum = 0
    if (data.compression.magic === '\x08\x00') {
      const stream = createInflateRaw()
      stream.end(data.compressedContent)
      for await (const chunk of stream) {
        length += chunk.length
        // Stop forged expansion at the declared size, without imposing a book-size cap.
        if (length > size) throw new Error('EPUB 压缩内容损坏')
        checksum = crc32(chunk, checksum)
      }
    } else if (data.compression.magic === '\x00\x00') {
      length = data.compressedContent.byteLength
      checksum = crc32(data.compressedContent)
    } else throw new Error('EPUB 压缩格式不支持')
    if (length !== size || checksum !== (data.crc32 >>> 0)) throw new Error('EPUB 压缩内容损坏')
  }
  if (await zip.file('mimetype')?.async('string') !== 'application/epub+zip' || !zip.file('META-INF/container.xml')) {
    throw new Error('文件不是完整的 EPUB')
  }
}
