import { describe, expect, it } from 'vitest'
import { estimateTokens } from '../../src/renderer/chat/tokens'

describe('长度估算', () => {
  it('空串是 0', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('中文按每字一个计(乘 1.15 余量后向上取整)', () => {
    // 原始:4 个汉字 = 4 token;余量:ceil(4 * 1.15) = ceil(4.6) = 5
    expect(estimateTokens('你好世界')).toBe(5)
  })

  it('英文按每四个字符一个计,向上取整,再乘余量', () => {
    // 'abcd':原始 ceil(4/4)=1;余量 ceil(1 * 1.15) = ceil(1.15) = 2
    expect(estimateTokens('abcd')).toBe(2)
    // 'abcde':原始 ceil(5/4)=2;余量 ceil(2 * 1.15) = ceil(2.3) = 3
    expect(estimateTokens('abcde')).toBe(3)
  })

  it('中英混排分别计算后相加,再乘余量', () => {
    // '你好'=2,'abcd' 原始 ceil(4/4)=1,合计原始 3;余量 ceil(3 * 1.15) = ceil(3.45) = 4
    expect(estimateTokens('你好abcd')).toBe(4)
  })

  it('估算值随文本变长而单调不减', () => {
    const short = estimateTokens('他终于明白')
    const long = estimateTokens('他终于明白过来,原来那天')
    expect(long).toBeGreaterThan(short)
  })

  it('中日韩标点和全角形式按每字一个计,不落入"每四个字符"分支', () => {
    // 「」《》是 U+3000–U+303F 范围内的中文标点,4 个字符原始计为 4 个 token
    // (若误落入 other/4 分支只会算成 1 个 token);余量 ceil(4 * 1.15) = 5
    expect(estimateTokens('「」《》')).toBe(5)
  })

  it('增补平面(扩展 B 及以上)的表意文字也按一字一 token 计', () => {
    // U+20000 是扩展 B 表意文字,原始计 1 个 token;余量 ceil(1 * 1.15) = 2
    expect(estimateTokens('\u{20000}')).toBe(2)
  })

  it('估算结果比未加余量前的原始值更大——方向是往多了算', () => {
    const raw = 20 // 20 个汉字,未加余量的原始估算
    const text = '汉'.repeat(raw)
    const withMargin = estimateTokens(text)
    expect(withMargin).toBeGreaterThan(raw)
    expect(withMargin).toBe(Math.ceil(raw * 1.15))
  })
})
