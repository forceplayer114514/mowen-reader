import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import JSZip from 'jszip'

const CHAPTERS = [
  { id: 'ch1', title: '第一章 开端', seed: '开端' },
  { id: 'ch2', title: '第二章 那个夏天', seed: '夏天' },
  { id: 'ch3', title: '第三章 归途', seed: '归途' }
]

/** 每章生成 60 段确定性中文正文,内容只取决于章节序号和段落序号。 */
function body(seed: string): string {
  const paragraphs: string[] = []
  for (let i = 1; i <= 60; i++) {
    paragraphs.push(
      `<p>${seed}的第${i}段。这是一段用于测试分页与划选的正文,它没有实际含义,` +
        `只保证每次生成完全相同。段落编号${i},长度固定,便于断言页面内容。</p>`
    )
  }
  return paragraphs.join('\n')
}

function chapterXhtml(title: string, seed: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head><title>${title}</title></head>
<body><h1>${title}</h1>
${body(seed)}
</body></html>`
}

export async function buildFixtureEpub(): Promise<Uint8Array> {
  const zip = new JSZip()

  // mimetype 必须是压缩包里第一个条目且不压缩,否则部分阅读器拒绝打开
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })

  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
  )

  const manifest = CHAPTERS.map(
    (c) => `<item id="${c.id}" href="${c.id}.xhtml" media-type="application/xhtml+xml"/>`
  ).join('\n    ')
  const spine = CHAPTERS.map((c) => `<itemref idref="${c.id}"/>`).join('\n    ')

  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:reader-fixture-0001</dc:identifier>
    <dc:title>测试之书</dc:title>
    <dc:creator>测试作者</dc:creator>
    <dc:language>zh-CN</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    ${manifest}
  </manifest>
  <spine>
    ${spine}
  </spine>
</package>`
  )

  zip.file(
    'OEBPS/nav.xhtml',
    `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN">
<head><title>目录</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>目录</h1>
    <ol>
${CHAPTERS.map((c) => `      <li><a href="${c.id}.xhtml">${c.title}</a></li>`).join('\n')}
    </ol>
  </nav>
</body></html>`
  )

  for (const c of CHAPTERS) {
    zip.file(`OEBPS/${c.id}.xhtml`, chapterXhtml(c.title, c.seed))
  }

  return zip.generateAsync({ type: 'uint8array' })
}

const isMain = process.argv[1] && resolve(process.argv[1]).endsWith('make-fixture-epub.ts')
if (isMain) {
  const out = resolve('tests/fixtures/sample.epub')
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, await buildFixtureEpub())
  console.log(`已生成 ${out}`)
}
