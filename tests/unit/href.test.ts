import { describe, expect, it } from 'vitest'
import { normalizeChapterHref } from '../../src/renderer/reader/href'

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
