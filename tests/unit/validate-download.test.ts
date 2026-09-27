import { expect, it } from 'vitest'
import JSZip from 'jszip'
import { buildFixtureEpub } from '../../scripts/make-fixture-epub'
import { validateDownloadedEpub } from '../../src/main/books/validate-download'

it('accepts a real EPUB and rejects HTML, missing manifest and traversal', async () => {
  await expect(validateDownloadedEpub(Buffer.from(await buildFixtureEpub()))).resolves.toBeUndefined()
  for (const bytes of [Buffer.from(''), Buffer.from('<html>Sign in</html>'), Buffer.from('PDF!')]) {
    await expect(validateDownloadedEpub(bytes)).rejects.toThrow('不是 EPUB')
  }
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  await expect(validateDownloadedEpub(await zip.generateAsync({ type: 'nodebuffer' }))).rejects.toThrow('完整')
  zip.file('META-INF/container.xml', '<container/>')
  zip.file('../escape.txt', 'unsafe')
  await expect(validateDownloadedEpub(await zip.generateAsync({ type: 'nodebuffer' }))).rejects.toThrow('路径')
})

it('rejects expansion bombs even when the central-directory size lies', async () => {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  zip.file('META-INF/container.xml', '<container/>')
  zip.file('bomb', 'a'.repeat(1024 * 1024))
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  let header = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  while (header !== -1) {
    const nameSize = bytes.readUInt16LE(header + 28)
    if (bytes.subarray(header + 46, header + 46 + nameSize).toString() === 'bomb') {
      bytes.writeUInt32LE(16, header + 24)
      break
    }
    header = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), header + 4)
  }
  await expect(validateDownloadedEpub(bytes)).rejects.toThrow()
})

it('allows legitimate empty ZIP resources and rejects a bad entry checksum', async () => {
  const zip = await JSZip.loadAsync(await buildFixtureEpub())
  zip.file('empty.css', '')
  const valid = await zip.generateAsync({ type: 'nodebuffer' })
  await expect(validateDownloadedEpub(valid)).resolves.toBeUndefined()
  const header = valid.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  valid.writeUInt32LE(0, header + 16)
  await expect(validateDownloadedEpub(valid)).rejects.toThrow('损坏')
})

it('rejects excessive entry tables and forged entry counts before ZIP allocation', async () => {
  const zip = new JSZip()
  for (let i = 0; i < 2001; i++) zip.file(`file-${i}`, '')
  const bytes = await zip.generateAsync({ type: 'nodebuffer' })
  await expect(validateDownloadedEpub(bytes)).rejects.toThrow('数量')
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  bytes.writeUInt16LE(1, end + 8)
  bytes.writeUInt16LE(1, end + 10)
  await expect(validateDownloadedEpub(bytes)).rejects.toThrow('数量')
})
