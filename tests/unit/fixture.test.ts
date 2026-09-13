import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import {
  buildBareNavFixtureEpub,
  buildFixtureEpub,
  buildRealisticFixtureEpub
} from '../../scripts/make-fixture-epub'

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

  it(
    '生成的 EPUB 字节完全相同,确保确定性(两次构建间隔超过 DOS 时间戳的 2 秒粒度)',
    async () => {
      const bytes1 = await buildFixtureEpub()
      await new Promise((r) => setTimeout(r, 2500))
      const bytes2 = await buildFixtureEpub()

      expect(bytes1.length).toBe(bytes2.length)
      expect(bytes1).toEqual(bytes2)
    },
    15000
  )
})

describe('更接近真实排版的样本 EPUB', () => {
  it('章节文件嵌套在 OEBPS/Text/ 下,而不是平铺在 OEBPS 里', async () => {
    const zip = await JSZip.loadAsync(await buildRealisticFixtureEpub())
    const names = Object.keys(zip.files)
    expect(names).toContain('OEBPS/Text/ch1.xhtml')
    expect(names).toContain('OEBPS/Text/ch2.xhtml')
    expect(names).toContain('OEBPS/Text/ch3.xhtml')
    expect(names).not.toContain('OEBPS/ch1.xhtml')
  })

  it('同时提供 EPUB 3 导航文档和 EPUB 2 的 toc.ncx', async () => {
    const zip = await JSZip.loadAsync(await buildRealisticFixtureEpub())
    const names = Object.keys(zip.files)
    expect(names).toContain('OEBPS/Text/nav.xhtml')
    expect(names).toContain('OEBPS/toc.ncx')
  })

  it('目录里的章节链接带 ../Text/ 前缀,和 spine 里的相对路径不是同一个字符串', async () => {
    const zip = await JSZip.loadAsync(await buildRealisticFixtureEpub())
    const nav = await zip.file('OEBPS/Text/nav.xhtml')!.async('string')
    expect(nav).toContain('href="../Text/ch1.xhtml"')
    const opf = await zip.file('OEBPS/content.opf')!.async('string')
    expect(opf).toContain('href="Text/ch1.xhtml"')
  })

  it('目录至少有两级嵌套', async () => {
    const zip = await JSZip.loadAsync(await buildRealisticFixtureEpub())
    const nav = await zip.file('OEBPS/Text/nav.xhtml')!.async('string')
    // 顶层 <ol> 内部还嵌了一层 <ol>,即第二级目录条目
    const topLevelOl = nav.indexOf('<ol>')
    const nestedOl = nav.indexOf('<ol>', topLevelOl + 1)
    expect(nestedOl).toBeGreaterThan(topLevelOl)
  })

  it('有封面图、章内插图和样式表,且都不是仓库里的二进制文件', async () => {
    const zip = await JSZip.loadAsync(await buildRealisticFixtureEpub())
    const names = Object.keys(zip.files)
    expect(names).toContain('OEBPS/Images/cover.png')
    expect(names).toContain('OEBPS/Images/inline.png')
    expect(names).toContain('OEBPS/Styles/style.css')

    const cover = await zip.file('OEBPS/Images/cover.png')!.async('uint8array')
    // PNG 文件签名的前 8 个字节是固定的
    expect(Array.from(cover.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10])

    const ch1 = await zip.file('OEBPS/Text/ch1.xhtml')!.async('string')
    expect(ch1).toContain('../Images/inline.png')
    expect(ch1).toContain('../Styles/style.css')
  })

  it('元数据写的是这个样本约定好的书名和作者', async () => {
    const zip = await JSZip.loadAsync(await buildRealisticFixtureEpub())
    const opf = await zip.file('OEBPS/content.opf')!.async('string')
    expect(opf).toContain('<dc:title>真实排版测试书</dc:title>')
    expect(opf).toContain('<dc:creator>真实测试作者</dc:creator>')
  })

  it(
    '生成的字节完全相同,确定性和简单样本一样成立',
    async () => {
      const bytes1 = await buildRealisticFixtureEpub()
      await new Promise((r) => setTimeout(r, 2500))
      const bytes2 = await buildRealisticFixtureEpub()

      expect(bytes1.length).toBe(bytes2.length)
      expect(bytes1).toEqual(bytes2)
    },
    15000
  )
})

describe('导航文档和章节同目录、裸文件名的样本 EPUB', () => {
  it('导航文档跟章节文件放在同一个 OEBPS/Text/ 目录下', async () => {
    const zip = await JSZip.loadAsync(await buildBareNavFixtureEpub())
    const names = Object.keys(zip.files)
    expect(names).toContain('OEBPS/Text/nav.xhtml')
    expect(names).toContain('OEBPS/Text/ch1.xhtml')
    expect(names).toContain('OEBPS/Text/ch2.xhtml')
    expect(names).toContain('OEBPS/Text/ch3.xhtml')
  })

  it('目录里的链接是裸文件名,不带 "../" 或任何目录前缀', async () => {
    const zip = await JSZip.loadAsync(await buildBareNavFixtureEpub())
    const nav = await zip.file('OEBPS/Text/nav.xhtml')!.async('string')
    expect(nav).toContain('href="ch1.xhtml"')
    expect(nav).not.toContain('../')
    const opf = await zip.file('OEBPS/content.opf')!.async('string')
    expect(opf).toContain('href="Text/ch1.xhtml"')
  })

  it('元数据写的是这个样本约定好的书名和作者', async () => {
    const zip = await JSZip.loadAsync(await buildBareNavFixtureEpub())
    const opf = await zip.file('OEBPS/content.opf')!.async('string')
    expect(opf).toContain('<dc:title>裸文件名目录测试书</dc:title>')
    expect(opf).toContain('<dc:creator>裸文件名测试作者</dc:creator>')
  })

  it(
    '生成的字节完全相同,确定性和另外两个样本一样成立',
    async () => {
      const bytes1 = await buildBareNavFixtureEpub()
      await new Promise((r) => setTimeout(r, 2500))
      const bytes2 = await buildBareNavFixtureEpub()

      expect(bytes1.length).toBe(bytes2.length)
      expect(bytes1).toEqual(bytes2)
    },
    15000
  )
})
