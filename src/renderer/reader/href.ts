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
