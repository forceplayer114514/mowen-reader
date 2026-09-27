import JSZip from 'jszip'
import { crc32, inflateRaw } from 'node:zlib'
import { promisify } from 'node:util'

export const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024
const inflate = promisify(inflateRaw)

// Bound the central directory before JSZip allocates its entry table. ZIP64/spanned archives
// are unnecessary for this reader's 64 MB / 2000-entry limit and are rejected here.
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

/** Check expansion limits before asking JSZip to decompress any entry. */
export async function validateDownloadedEpub(bytes: Buffer): Promise<void> {
  if (bytes.length > MAX_DOWNLOAD_BYTES) throw new Error('电子书超过 64 MB 限制')
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) throw new Error('下载文件不是 EPUB（可能是登录或错误页面）')
  checkEntryCount(bytes)
  const zip = await JSZip.loadAsync(bytes)
  const entries = Object.values(zip.files)
  if (entries.length > 2000) throw new Error('EPUB 文件数量过多')
  let expanded = 0
  for (const entry of entries) {
    const original = entry.unsafeOriginalName || entry.name
    if (/^[\\/]|(^|[\\/])\.\.([\\/]|$)|\0/.test(original)) throw new Error('EPUB 包含不安全路径')
    if (entry.dir) continue
    // ponytail: JSZip 3.x exposes central-directory sizes on _data; recheck on a major upgrade.
    const data = (entry as unknown as { _data: { uncompressedSize: number; crc32: number; compressedContent: Uint8Array; compression: { magic: string } } })._data
    // JSZip normalizes zero-size files to a resolved empty-data promise, not CompressedObject.
    if (data instanceof Promise && (await data).length === 0) continue
    const size = data.uncompressedSize
    if (!Number.isSafeInteger(size) || size < 0 || size > 32 * 1024 * 1024) throw new Error('EPUB 内容过大')
    expanded += size
    if (expanded > 128 * 1024 * 1024) throw new Error('EPUB 解压内容超过限制')
    // Bound real expansion too: a forged central-directory size must not bypass the limit.
    const decoded = data.compression.magic === '\x08\x00'
      ? await inflate(data.compressedContent, { maxOutputLength: Math.max(1, size) })
      : data.compression.magic === '\x00\x00' ? data.compressedContent : null
    if (!decoded || decoded.byteLength !== size || crc32(decoded) !== (data.crc32 >>> 0)) throw new Error('EPUB 压缩内容损坏')
  }
  if (await zip.file('mimetype')?.async('string') !== 'application/epub+zip' || !zip.file('META-INF/container.xml')) {
    throw new Error('文件不是完整的 EPUB')
  }
}
