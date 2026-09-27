import JSZip from 'jszip'
import { decodeText } from '@shared/book-text'
export { decodeText } from '@shared/book-text'

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (value) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[value]!)
}

/** Deterministic chapters/DOM preserve all existing EPUB position and annotation logic. */
export async function textToEpub(data: ArrayBuffer, title: string): Promise<ArrayBuffer> {
  const paragraphs = decodeText(data).split(/\n+/)
  const chapters: { title: string; lines: string[] }[] = []
  let current = { title: title || '正文', lines: [] as string[] }
  let length = 0
  for (const line of paragraphs) {
    const heading = /^(第[零一二三四五六七八九十百千万两\d]+[章节回卷部篇].{0,70}|chapter\s+\d+.{0,70})$/i.test(line.trim())
    // ponytail: split unstructured long TXT at paragraph boundaries (~30k chars), not guessed page numbers.
    if (current.lines.length && (heading || length >= 30000)) {
      chapters.push(current)
      current = { title: heading ? line.trim() : `正文 ${chapters.length + 1}`, lines: [] }
      length = 0
    } else if (heading && !current.lines.length) current.title = line.trim()
    current.lines.push(line)
    length += line.length
  }
  chapters.push(current)
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
  const nav = chapters.map((c, i) => `<li><a href="ch${i}.xhtml">${escapeXml(c.title)}</a></li>`).join('')
  zip.file('nav.xhtml', `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol>${nav}</ol></nav></body></html>`)
  chapters.forEach((c, i) => zip.file(`ch${i}.xhtml`, `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${escapeXml(c.title)}</title><style>body{line-height:1.8}p{white-space:pre-wrap;text-indent:2em;overflow-wrap:anywhere}</style></head><body>${c.lines.map((l) => `<p>${escapeXml(l)}</p>`).join('')}</body></html>`))
  zip.file('content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">mowen-txt</dc:identifier><dc:title>${escapeXml(title)}</dc:title><dc:language>zh</dc:language><meta property="dcterms:modified">2026-01-01T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>${chapters.map((_, i) => `<item id="ch${i}" href="ch${i}.xhtml" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine>${chapters.map((_, i) => `<itemref idref="ch${i}"/>`).join('')}</spine></package>`)
  return zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' })
}
