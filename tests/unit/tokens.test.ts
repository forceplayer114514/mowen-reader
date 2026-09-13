import { describe, expect, it } from 'vitest'
import { estimateTokens } from '../../src/renderer/chat/tokens'

describe('长度估算', () => {
  it('空串是 0', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('中文按每字一个计', () => {
    expect(estimateTokens('你好世界')).toBe(4)
  })

  it('英文按每四个字符一个计,向上取整', () => {
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })

  it('中英混排分别计算后相加', () => {
    expect(estimateTokens('你好abcd')).toBe(3)
  })

  it('估算值随文本变长而单调不减', () => {
    const short = estimateTokens('他终于明白')
    const long = estimateTokens('他终于明白过来,原来那天')
    expect(long).toBeGreaterThan(short)
  })
})
