/**
 * 归一化章节路径,用来判断目录里的某一项和当前正在显示的章节是不是同一份文档。
 *
 * 要处理两个问题:
 * 1) 目录链接可能带 #锚点(跳到章节内的某个小节),判断"是不是同一章"时要忽略锚点。
 * 2) 目录链接和 spine 报告的路径,即便指向同一个文件,写法也可能不一样——比如
 *    EPUB 3 导航文档本身放在 OEBPS/Text/ 里,链接同目录的章节时写成从 OEBPS
 *    出发再绕回来的 "../Text/ch1.xhtml",而 spine 报告的是相对 OEBPS 的
 *    "Text/ch1.xhtml"。这两个字符串没有共同的、已知的基准目录,没法用标准的
 *    URL 解析去算"绝对路径"——这里按段处理 "." 和 ".."：遇到 ".." 时,如果
 *    前面已经没有可以退回的目录段了,就直接丢弃这一段,而不是保留一个用不上的
 *    ".."。对这两个例子来说,结果都会归一化成 "Text/ch1.xhtml",能够比较相等。
 */
export function normalizeChapterHref(href: string): string {
  const withoutFragment = href.split('#')[0]
  const segments = withoutFragment.split('/')
  const stack: string[] = []
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (stack.length > 0) stack.pop()
      continue
    }
    stack.push(segment)
  }
  return stack.join('/')
}

/** 取路径里目录部分(不含末尾斜杠);没有 "/" 时说明就在根目录,返回空字符串。 */
function directoryOf(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx === -1 ? '' : path.slice(0, idx)
}

/** 解码 href 里的百分号转义;遇到不合法的转义序列(比如孤立的 "%")原样返回,不抛错。 */
function decodePercentEncoding(href: string): string {
  try {
    return decodeURIComponent(href)
  } catch {
    return href
  }
}

/**
 * 把导航文档(EPUB 3 的 nav.xhtml,或没有 nav 时退回的 EPUB 2 toc.ncx)里写的原始
 * href,解析成和 spine 报告的路径同一基准的相对路径(相对 OPF 目录),供上层归一化
 * 比较用。
 *
 * 问题出在 epub.js 自己身上:它解析导航文档时只是原样读出 `<a href>` /
 * `<content src>` 属性值(见 node_modules/epubjs/src/navigation.js 的 parseNav()/
 * parseNcx(),两处都是 `content.getAttribute('href'/'src')` 直接拿字符串),
 * 从来没有把这个值解析到导航文档自己的实际位置——但 HTML/XML 里的相对链接,
 * 语义上就是相对"写这个链接的文档自己所在的目录",不是相对 OPF 目录。
 *
 * 之前 normalizeChapterHref() 只处理了 "导航文档自己就在 Text/ 目录下,但作者
 * 手滑写成从 OEBPS 绕回来的 ../Text/ch1.xhtml" 这一种(仍然合法、只是啰嗦的)
 * 写法。但同样常见、Sigil 默认就这么生成的另一种写法——导航文档和它链接的章节
 * 放在同一目录,链接直接写不带任何前缀的裸文件名,比如 "ch1.xhtml"——
 * normalizeChapterHref() 单独处理不了:它不知道这个相对路径是相对哪个目录写的,
 * 只能原样吐回 "ch1.xhtml",而 spine 报告的是相对 OPF 目录的 "Text/ch1.xhtml",
 * 两者永远比较不出相等。
 *
 * 这里补上 epub.js 没做的这一步解析:navigationDocumentPath 是导航文档自己相对
 * OPF 目录的路径,从 book.packaging.navPath 拿(没有 EPUB 3 导航文档、只有 EPUB 2
 * toc.ncx 时用 book.packaging.ncxPath——epub.js 自己内部也是这么退回的,见
 * node_modules/epubjs/src/book.js loadNavigation() 里的
 * `packaging.navPath || packaging.ncxPath`)。取它的目录部分,和 href 拼在一起,
 * 再交给 normalizeChapterHref() 处理 "."/".." 段,两种写法都会归一化成同一个、
 * 和 spine 路径同一基准的结果。
 *
 * 同时在这里解码百分号转义:导航文档里的链接可能被生成工具编码过(比如文件名
 * 里的空格写成 "%20"),而 spine 报告的路径通常是解码后的原始文件名,不解码
 * 直接比较同样会一直匹配不上。
 *
 * 返回值保留原始的 "#锚点"(如果有),不做解析——锚点不影响文件层面的路径解析,
 * 调用方各自决定要不要再拿 normalizeChapterHref() 去掉它。
 */
export function resolveNavigationHref(href: string, navigationDocumentPath: string): string {
  const fragmentIndex = href.indexOf('#')
  const fragment = fragmentIndex === -1 ? '' : href.slice(fragmentIndex)
  const path = fragmentIndex === -1 ? href : href.slice(0, fragmentIndex)
  const decoded = decodePercentEncoding(path)
  const dir = directoryOf(navigationDocumentPath)
  const combined = dir ? `${dir}/${decoded}` : decoded
  return `${normalizeChapterHref(combined)}${fragment}`
}
