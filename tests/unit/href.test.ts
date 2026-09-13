import { describe, expect, it } from 'vitest'
import { normalizeChapterHref, resolveNavigationHref } from '../../src/renderer/reader/href'

describe('章节路径归一化', () => {
  it('没有特殊字符的路径原样返回', () => {
    expect(normalizeChapterHref('Text/ch1.xhtml')).toBe('Text/ch1.xhtml')
  })

  it('忽略 # 锚点', () => {
    expect(normalizeChapterHref('Text/ch1.xhtml#s2')).toBe('Text/ch1.xhtml')
  })

  it('真实书籍常见的写法:目录带 ../ 前缀,和 spine 报告的路径归一化后相等', () => {
    expect(normalizeChapterHref('../Text/ch1.xhtml')).toBe(normalizeChapterHref('Text/ch1.xhtml'))
    expect(normalizeChapterHref('../Text/ch1.xhtml')).toBe('Text/ch1.xhtml')
  })

  it('同时出现 ../ 和 #锚点也能正确归一化', () => {
    expect(normalizeChapterHref('../Text/ch1.xhtml#s2')).toBe('Text/ch1.xhtml')
  })

  it('./ 当前目录段被忽略', () => {
    expect(normalizeChapterHref('./Text/ch1.xhtml')).toBe('Text/ch1.xhtml')
  })

  it('多余的 .. 没有可以退回的目录段时被丢弃,不保留在结果里', () => {
    expect(normalizeChapterHref('../../Text/ch1.xhtml')).toBe('Text/ch1.xhtml')
  })

  it('.. 会正确抵消它前面的一级目录', () => {
    expect(normalizeChapterHref('Text/Sub/../ch1.xhtml')).toBe('Text/ch1.xhtml')
  })

  it('空字符串归一化为空字符串', () => {
    expect(normalizeChapterHref('')).toBe('')
  })

  it('只有锚点的字符串归一化为空字符串', () => {
    expect(normalizeChapterHref('#s2')).toBe('')
  })
})

describe('把导航文档里的原始 href 解析到和 spine 同一基准(resolveNavigationHref)', () => {
  // 导航文档在 OEBPS/Text/nav.xhtml,相对 OPF 目录(OEBPS)的路径就是 "Text/nav.xhtml",
  // 目录部分是 "Text"——下面三个用例都拿它当基准,分别覆盖三种真实世界会出现的写法。
  const navDocPath = 'Text/nav.xhtml'

  it('从 OEBPS 绕回来的 "../Text/ch1.xhtml" 形式,解析后和 spine 报告的路径相等', () => {
    expect(resolveNavigationHref('../Text/ch1.xhtml', navDocPath)).toBe('Text/ch1.xhtml')
  })

  it('导航文档和章节同目录、裸文件名 "ch1.xhtml" 形式,解析后同样等于 spine 报告的路径', () => {
    expect(resolveNavigationHref('ch1.xhtml', navDocPath)).toBe('Text/ch1.xhtml')
  })

  it('百分号转义的文件名,解析时会先解码,再和未转义的 spine 路径对上', () => {
    // 文件名里带空格,导航文档里把空格写成 %20;spine 报告的路径通常是解码后的原始文件名。
    expect(resolveNavigationHref('ch%201.xhtml', navDocPath)).toBe('Text/ch 1.xhtml')
  })

  it('保留 #锚点,不做解析,交给调用方自己决定要不要再去掉', () => {
    expect(resolveNavigationHref('../Text/ch1.xhtml#s2', navDocPath)).toBe('Text/ch1.xhtml#s2')
    expect(resolveNavigationHref('ch1.xhtml#s2', navDocPath)).toBe('Text/ch1.xhtml#s2')
  })

  it('导航文档在 OPF 根目录时(没有目录部分),裸文件名原样归一化,不会多出斜杠', () => {
    expect(resolveNavigationHref('ch1.xhtml', 'nav.xhtml')).toBe('ch1.xhtml')
  })

  it('不合法的百分号转义序列原样保留,不抛错', () => {
    expect(resolveNavigationHref('ch1%.xhtml', navDocPath)).toBe('Text/ch1%.xhtml')
  })
})
