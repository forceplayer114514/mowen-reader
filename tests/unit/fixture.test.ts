import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { buildFixtureEpub } from '../../scripts/make-fixture-epub'

describe('样本 EPUB', () => {
  it('是个 zip,且第一个条目是未压缩的 mimetype', async () => {
    const bytes = await buildFixtureEpub()
    const text = new TextDecoder().decode(bytes.slice(0, 60))
    expect(text).toContain('mimetype')
    expect(text).toContain('application/epub+zip')
  })

  it('包含 EPUB 必需的文件', async () => {
    const zip = await JSZip.loadAsync(await buildFixtureEpub())
    const names = Object.keys(zip.files)
    expect(names).toContain('META-INF/container.xml')
    expect(names).toContain('OEBPS/content.opf')
    expect(names).toContain('OEBPS/nav.xhtml')
    expect(names).toContain('OEBPS/ch1.xhtml')
    expect(names).toContain('OEBPS/ch2.xhtml')
    expect(names).toContain('OEBPS/ch3.xhtml')
  })

  it('元数据写的是约定好的书名和作者', async () => {
    const zip = await JSZip.loadAsync(await buildFixtureEpub())
    const opf = await zip.file('OEBPS/content.opf')!.async('string')
    expect(opf).toContain('<dc:title>测试之书</dc:title>')
    expect(opf).toContain('<dc:creator>测试作者</dc:creator>')
  })

  it('正文足够长,至少能分出好几页', async () => {
    const zip = await JSZip.loadAsync(await buildFixtureEpub())
    const ch1 = await zip.file('OEBPS/ch1.xhtml')!.async('string')
    expect(ch1.length).toBeGreaterThan(4000)
  })

  it('生成的 EPUB 字节完全相同,确保确定性', async () => {
    const bytes1 = await buildFixtureEpub()
    const bytes2 = await buildFixtureEpub()

    expect(bytes1.length).toBe(bytes2.length)
    expect(bytes1).toEqual(bytes2)
  })
})
