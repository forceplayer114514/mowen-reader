import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import JSZip from 'jszip'

// 压缩包里每个条目都盖同一个固定时间戳,是字节确定性的前提——用当前时间会导致
// 每次生成的字节都不一样,两次构建就没法比较。两个样本共用同一个时间戳常量。
// 用 1980-01-01 而不是 new Date(0)(1970 年):ZIP 格式自己的时间戳字段用的是
// DOS 日期时间格式,其纪元是 1980 年,表示不了 1970 年——JSZip 会把这个更早的
// 时间存成溢出后的高位值,一堆归档工具(包括 Finder/资源管理器)解出来的年份
// 会变成 2098,而不是抛错或钳到最小值。1980-01-01 是这个格式能表示的最早时间。
const ENTRY_DATE = new Date('1980-01-01T00:00:00Z')

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

/**
 * 生成最简单的测试样本:EPUB 3、纯文本三章、没有图片/样式表/封面、
 * 所有文件平铺在 OEBPS 下、目录只有一级。端到端测试依赖它的确切文字内容和
 * 字节确定性,这里的结构和文字都不能变。
 * 真实世界的书远比这复杂——嵌套目录、多级目录、图片、样式表、EPUB 2 的
 * toc.ncx——那些场景由下面的 buildRealisticFixtureEpub() 覆盖,两者互不影响。
 */
export async function buildFixtureEpub(): Promise<Uint8Array> {
  const zip = new JSZip()

  // mimetype 必须是压缩包里第一个条目且不压缩,否则部分阅读器拒绝打开
  zip.file('mimetype', 'application/epub+zip', {
    compression: 'STORE',
    date: ENTRY_DATE,
    createFolders: false
  })

  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
    { date: ENTRY_DATE, createFolders: false }
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
</package>`,
    { date: ENTRY_DATE, createFolders: false }
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
</body></html>`,
    { date: ENTRY_DATE, createFolders: false }
  )

  for (const c of CHAPTERS) {
    zip.file(`OEBPS/${c.id}.xhtml`, chapterXhtml(c.title, c.seed), {
      date: ENTRY_DATE,
      createFolders: false
    })
  }

  return zip.generateAsync({ type: 'uint8array' })
}

// --- 下面是更接近真实世界排版的第二个样本,用于覆盖简单样本测试不到的场景 ---

const REAL_TITLE = '真实排版测试书'
const REAL_AUTHOR = '真实测试作者'

const REAL_CHAPTERS = [
  { id: 'ch1', title: '第一章 楔子', seed: '楔子' },
  { id: 'ch2', title: '第二章 正文', seed: '正文' },
  { id: 'ch3', title: '第三章 尾声', seed: '尾声' }
]

function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]
    for (let bit = 0; bit < 8; bit++) {
      const mask = -(crc & 1)
      crc = (crc >>> 1) ^ (0xedb88320 & mask)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type)
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(typeBytes, 4)
  out.set(data, 8)
  const crcInput = new Uint8Array(4 + data.length)
  crcInput.set(typeBytes, 0)
  crcInput.set(data, 4)
  view.setUint32(8 + data.length, crc32(crcInput))
  return out
}

/**
 * 用代码生成一张纯色 PNG,不往仓库里塞二进制文件。像素固定 8 位深、RGB 真彩色,
 * 不做任何抖动或随机噪声,deflateSync 在同样输入和参数下总是产出同样的压缩结果,
 * 所以这张图片本身也是确定性的,不会破坏整份 EPUB 的字节确定性。
 */
function makeSolidPng(width: number, height: number, rgb: [number, number, number]): Uint8Array {
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

  const ihdr = new Uint8Array(13)
  const ihdrView = new DataView(ihdr.buffer)
  ihdrView.setUint32(0, width)
  ihdrView.setUint32(4, height)
  ihdr[8] = 8 // 位深
  ihdr[9] = 2 // 颜色类型:真彩色(RGB),不带 alpha

  const rowBytes = width * 3
  const raw = new Uint8Array((rowBytes + 1) * height)
  for (let y = 0; y < height; y++) {
    const rowStart = y * (rowBytes + 1)
    raw[rowStart] = 0 // 每行开头的过滤器类型字节:0 = 不过滤,直接铺颜色
    for (let x = 0; x < width; x++) {
      const p = rowStart + 1 + x * 3
      raw[p] = rgb[0]
      raw[p + 1] = rgb[1]
      raw[p + 2] = rgb[2]
    }
  }
  const idatData = deflateSync(raw, { level: 9 })

  const chunks = [
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idatData),
    pngChunk('IEND', new Uint8Array(0))
  ]
  const total = chunks.reduce((n, c) => n + c.length, signature.length)
  const out = new Uint8Array(total)
  out.set(signature, 0)
  let offset = signature.length
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

function realisticChapterXhtml(title: string, seed: string, withImage: boolean): string {
  const img = withImage
    ? `<p><img src="../Images/inline.png" alt="插图" width="40" height="40"/></p>\n`
    : ''
  const anchor = withImage ? ' id="s1"' : ''
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head>
  <title>${title}</title>
  <link rel="stylesheet" type="text/css" href="../Styles/style.css"/>
</head>
<body>
<h1${anchor}>${title}</h1>
${img}${body(seed)}
</body></html>`
}

/**
 * EPUB 3 导航文档,故意放在 OEBPS/Text/ 里(和章节文件同级,Calibre 之类的
 * 真实工具常这么放),但链接却写成 "../Text/ch1.xhtml" 这种从 OEBPS 出发再
 * 绕回 Text/ 的形式,而不是同目录下更简短的 "ch1.xhtml"。这确实是不少真实
 * 转换工具会生成的冗余但合法的相对路径(浏览器打开能正常跳转),用来复现
 * review 里提到的缺陷:目录项的 href 和 spine 报告的 href 字符串不一致
 * (前者是 "../Text/ch1.xhtml",后者是 "Text/ch1.xhtml"),按原始字符串比较
 * 会永远匹配不上。
 */
function realisticNavXhtml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN">
<head><title>目录</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>目录</h1>
    <ol>
      <li><a href="../Text/ch1.xhtml">${REAL_CHAPTERS[0].title}</a>
        <ol>
          <li><a href="../Text/ch1.xhtml#s1">第一节 起</a></li>
        </ol>
      </li>
      <li><a href="../Text/ch2.xhtml">${REAL_CHAPTERS[1].title}</a></li>
      <li><a href="../Text/ch3.xhtml">${REAL_CHAPTERS[2].title}</a></li>
    </ol>
  </nav>
</body></html>`
}

/** EPUB 2 的 toc.ncx,和 content.opf 同级,链接直接写 "Text/chN.xhtml"(不需要 ../)。 */
function realisticTocNcx(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:reader-fixture-real-0001"/>
  </head>
  <docTitle><text>${REAL_TITLE}</text></docTitle>
  <navMap>
    <navPoint id="np-1" playOrder="1">
      <navLabel><text>${REAL_CHAPTERS[0].title}</text></navLabel>
      <content src="Text/ch1.xhtml"/>
      <navPoint id="np-1-1" playOrder="2">
        <navLabel><text>第一节 起</text></navLabel>
        <content src="Text/ch1.xhtml#s1"/>
      </navPoint>
    </navPoint>
    <navPoint id="np-2" playOrder="3">
      <navLabel><text>${REAL_CHAPTERS[1].title}</text></navLabel>
      <content src="Text/ch2.xhtml"/>
    </navPoint>
    <navPoint id="np-3" playOrder="4">
      <navLabel><text>${REAL_CHAPTERS[2].title}</text></navLabel>
      <content src="Text/ch3.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`
}

function realisticContentOpf(): string {
  const manifestItems = REAL_CHAPTERS.map(
    (c) => `<item id="${c.id}" href="Text/${c.id}.xhtml" media-type="application/xhtml+xml"/>`
  ).join('\n    ')
  const spine = REAL_CHAPTERS.map((c) => `<itemref idref="${c.id}"/>`).join('\n    ')
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:identifier id="bookid">urn:uuid:reader-fixture-real-0001</dc:identifier>
    <dc:title>${REAL_TITLE}</dc:title>
    <dc:creator>${REAL_AUTHOR}</dc:creator>
    <dc:language>zh-CN</dc:language>
    <meta name="cover" content="cover-image"/>
  </metadata>
  <manifest>
    <item id="nav" href="Text/nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="Styles/style.css" media-type="text/css"/>
    <item id="cover-image" href="Images/cover.png" media-type="image/png" properties="cover-image"/>
    <item id="inline-image" href="Images/inline.png" media-type="image/png"/>
    ${manifestItems}
  </manifest>
  <spine toc="ncx">
    ${spine}
  </spine>
</package>`
}

const REAL_STYLESHEET = `body { font-family: serif; line-height: 1.6; }\nh1 { text-align: center; }\n`

/**
 * 更接近真实世界排版的样本:章节文件嵌套在 OEBPS/Text/ 下、有独立样式表、
 * 有封面图和一张章内插图、目录至少两级、同时提供 EPUB 3 导航文档和 EPUB 2
 * 的 toc.ncx。设计说明里点名要覆盖的中文书/带图片/多级目录场景都在这里。
 * 和 buildFixtureEpub() 一样靠固定时间戳保证字节确定性,互不影响、互不共用状态。
 */
export async function buildRealisticFixtureEpub(): Promise<Uint8Array> {
  const zip = new JSZip()

  zip.file('mimetype', 'application/epub+zip', {
    compression: 'STORE',
    date: ENTRY_DATE,
    createFolders: false
  })

  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
    { date: ENTRY_DATE, createFolders: false }
  )

  zip.file('OEBPS/content.opf', realisticContentOpf(), { date: ENTRY_DATE, createFolders: false })
  zip.file('OEBPS/toc.ncx', realisticTocNcx(), { date: ENTRY_DATE, createFolders: false })
  zip.file('OEBPS/Text/nav.xhtml', realisticNavXhtml(), { date: ENTRY_DATE, createFolders: false })
  zip.file('OEBPS/Styles/style.css', REAL_STYLESHEET, { date: ENTRY_DATE, createFolders: false })
  zip.file('OEBPS/Images/cover.png', makeSolidPng(96, 144, [178, 34, 34]), {
    date: ENTRY_DATE,
    createFolders: false
  })
  zip.file('OEBPS/Images/inline.png', makeSolidPng(40, 40, [34, 139, 34]), {
    date: ENTRY_DATE,
    createFolders: false
  })

  for (const c of REAL_CHAPTERS) {
    zip.file(`OEBPS/Text/${c.id}.xhtml`, realisticChapterXhtml(c.title, c.seed, c.id === 'ch1'), {
      date: ENTRY_DATE,
      createFolders: false
    })
  }

  return zip.generateAsync({ type: 'uint8array' })
}

const BARE_TITLE = '裸文件名目录测试书'
const BARE_AUTHOR = '裸文件名测试作者'

const BARE_CHAPTERS = [
  { id: 'ch1', title: '第一章 起点', seed: '起点' },
  { id: 'ch2', title: '第二章 中途', seed: '中途' },
  { id: 'ch3', title: '第三章 终点', seed: '终点' }
]

/**
 * 导航文档(EPUB 3 nav.xhtml)和它链接的章节放在同一目录下(OEBPS/Text/),
 * 链接直接写不带任何前缀的裸文件名,比如 "ch1.xhtml"——Sigil 默认就生成这种写法。
 */
function bareNavXhtml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN">
<head><title>目录</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>目录</h1>
    <ol>
${BARE_CHAPTERS.map((c) => `      <li><a href="${c.id}.xhtml">${c.title}</a></li>`).join('\n')}
    </ol>
  </nav>
</body></html>`
}

function bareContentOpf(): string {
  const manifestItems = BARE_CHAPTERS.map(
    (c) => `<item id="${c.id}" href="Text/${c.id}.xhtml" media-type="application/xhtml+xml"/>`
  ).join('\n    ')
  const spine = BARE_CHAPTERS.map((c) => `<itemref idref="${c.id}"/>`).join('\n    ')
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:reader-fixture-barenav-0001</dc:identifier>
    <dc:title>${BARE_TITLE}</dc:title>
    <dc:creator>${BARE_AUTHOR}</dc:creator>
    <dc:language>zh-CN</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="Text/nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    ${manifestItems}
  </manifest>
  <spine>
    ${spine}
  </spine>
</package>`
}

/**
 * 第三个样本,专门复现 review 指出的第二种真实场景:导航文档跟它链接的章节放在
 * 同一目录(OEBPS/Text/ 下),链接直接写不带任何前缀的裸文件名(比如 "ch1.xhtml"),
 * 而不是 buildRealisticFixtureEpub() 里那种从 OEBPS 绕回来的 "../Text/ch1.xhtml"。
 * 这是 Sigil 默认就会生成的写法,和前一种同样常见,但字符串形态不同、不能互相
 * 替代验证:前者归一化路径的 ".."/"." 段就能和 spine 对上,后者必须先把 href
 * 解析到导航文档自己的目录下才行,光归一化没用(见 href.ts 里
 * resolveNavigationHref() 的注释)。只保留验证这一件事所需的最小结构——样式表、
 * 封面图、EPUB 2 toc.ncx 已经由 buildRealisticFixtureEpub() 覆盖过,这里重复
 * 只会让样本更难看懂。和另外两个样本一样靠固定时间戳保证字节确定性。
 */
export async function buildBareNavFixtureEpub(): Promise<Uint8Array> {
  const zip = new JSZip()

  zip.file('mimetype', 'application/epub+zip', {
    compression: 'STORE',
    date: ENTRY_DATE,
    createFolders: false
  })

  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
    { date: ENTRY_DATE, createFolders: false }
  )

  zip.file('OEBPS/content.opf', bareContentOpf(), { date: ENTRY_DATE, createFolders: false })
  zip.file('OEBPS/Text/nav.xhtml', bareNavXhtml(), { date: ENTRY_DATE, createFolders: false })

  for (const c of BARE_CHAPTERS) {
    zip.file(`OEBPS/Text/${c.id}.xhtml`, chapterXhtml(c.title, c.seed), {
      date: ENTRY_DATE,
      createFolders: false
    })
  }

  return zip.generateAsync({ type: 'uint8array' })
}

// --- 第四个样本:正文段落里带一个指向另一章的链接 ---

const LINK_TITLE = '正文带链接测试书'
const LINK_AUTHOR = '链接测试作者'

const LINK_CHAPTERS = [
  { id: 'ch1', title: '第一章 交叉引用', seed: '交叉引用' },
  { id: 'ch2', title: '第二章 被引到的那一章', seed: '被引到' }
]

/** 整段文字都躺在一个指向另一章的链接里,拖选它必然整段落在链接上。 */
const LINK_PARAGRAPH =
  '<p><a href="ch2.xhtml">这一整段字都在一个指向第二章的链接里面,随手拖选一句就整段落在链接上</a></p>'

/**
 * 第一章的正文第一段就是一个书内链接。真实的书里这种形状到处都是:书自带的目录页、
 * 脚注编号、交叉引用的小标题,整段文字都包在一个 <a> 里,而用户照样会去划选它。
 * 前三个样本的正文里一个链接都没有(只有导航文档里有),所以这种情形一条用例都
 * 够不到——划选松手之后浏览器补发的那一下 click,目标正是这个 <a>。
 */
function linkedChapterXhtml(title: string, seed: string, withLink: boolean): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head><title>${title}</title></head>
<body><h1>${title}</h1>
${withLink ? `${LINK_PARAGRAPH}\n` : ''}${body(seed)}
</body></html>`
}

/**
 * 只保留验证这一件事所需的最小结构:两章、平铺在 OEBPS 下、一级目录,和最简单的
 * 那个样本一样,唯一的区别是第一章正文里多了一个指向第二章的链接。和另外三个样本
 * 一样靠固定时间戳保证字节确定性,互不影响、互不共用状态。
 */
export async function buildLinkedFixtureEpub(): Promise<Uint8Array> {
  const zip = new JSZip()

  zip.file('mimetype', 'application/epub+zip', {
    compression: 'STORE',
    date: ENTRY_DATE,
    createFolders: false
  })

  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
    { date: ENTRY_DATE, createFolders: false }
  )

  const manifest = LINK_CHAPTERS.map(
    (c) => `<item id="${c.id}" href="${c.id}.xhtml" media-type="application/xhtml+xml"/>`
  ).join('\n    ')
  const spine = LINK_CHAPTERS.map((c) => `<itemref idref="${c.id}"/>`).join('\n    ')

  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:reader-fixture-linked-0001</dc:identifier>
    <dc:title>${LINK_TITLE}</dc:title>
    <dc:creator>${LINK_AUTHOR}</dc:creator>
    <dc:language>zh-CN</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    ${manifest}
  </manifest>
  <spine>
    ${spine}
  </spine>
</package>`,
    { date: ENTRY_DATE, createFolders: false }
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
${LINK_CHAPTERS.map((c) => `      <li><a href="${c.id}.xhtml">${c.title}</a></li>`).join('\n')}
    </ol>
  </nav>
</body></html>`,
    { date: ENTRY_DATE, createFolders: false }
  )

  for (const c of LINK_CHAPTERS) {
    zip.file(`OEBPS/${c.id}.xhtml`, linkedChapterXhtml(c.title, c.seed, c.id === 'ch1'), {
      date: ENTRY_DATE,
      createFolders: false
    })
  }

  return zip.generateAsync({ type: 'uint8array' })
}

const isMain = process.argv[1] && resolve(process.argv[1]).endsWith('make-fixture-epub.ts')
if (isMain) {
  const out = resolve('tests/fixtures/sample.epub')
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, await buildFixtureEpub())
  console.log(`已生成 ${out}`)

  const realOut = resolve('tests/fixtures/sample-realistic.epub')
  writeFileSync(realOut, await buildRealisticFixtureEpub())
  console.log(`已生成 ${realOut}`)

  const bareOut = resolve('tests/fixtures/sample-barenav.epub')
  writeFileSync(bareOut, await buildBareNavFixtureEpub())
  console.log(`已生成 ${bareOut}`)

  const linkedOut = resolve('tests/fixtures/sample-linked.epub')
  writeFileSync(linkedOut, await buildLinkedFixtureEpub())
  console.log(`已生成 ${linkedOut}`)
}
