import { describe, expect, it } from 'vitest'
import { createSseParser } from '../../src/main/llm/sse'

function chunk(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
}

describe('流式响应解析', () => {
  it('一个完整事件吐出一段文字', () => {
    const p = createSseParser()
    expect(p.push(chunk('你好'))).toEqual(['你好'])
  })

  it('多个事件挤在同一个网络片段里,按顺序全部吐出', () => {
    const p = createSseParser()
    expect(p.push(chunk('你') + chunk('好'))).toEqual(['你', '好'])
  })

  it('事件被切成两半到达时,先缓冲再吐出', () => {
    const p = createSseParser()
    const whole = chunk('分两次到达')
    const cut = Math.floor(whole.length / 2)
    expect(p.push(whole.slice(0, cut))).toEqual([])
    expect(p.push(whole.slice(cut))).toEqual(['分两次到达'])
  })

  it('结束标记不产生文字', () => {
    const p = createSseParser()
    expect(p.push('data: [DONE]\n\n')).toEqual([])
  })

  it('没有 content 的增量被跳过(例如只带 role 的首帧)', () => {
    const p = createSseParser()
    const only = `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n`
    expect(p.push(only)).toEqual([])
  })

  it('空行与注释行被忽略', () => {
    const p = createSseParser()
    expect(p.push(`\n: 心跳\n\n${chunk('正文')}`)).toEqual(['正文'])
  })

  it('不是 JSON 的数据行被跳过而不是抛错', () => {
    const p = createSseParser()
    expect(p.push('data: {坏掉的\n\n' + chunk('后面的还要'))).toEqual(['后面的还要'])
  })

  it('内容是空字符串的增量被跳过,不产生空片段', () => {
    const p = createSseParser()
    expect(p.push(chunk(''))).toEqual([])
  })

  it('done() 之后缓冲里的残缺数据被丢弃,不会误吐', () => {
    const p = createSseParser()
    p.push('data: {"choices":[{"delta":{"content":"半截')
    p.done()
    expect(p.push('')).toEqual([])
  })

  it('CRLF 换行的完整流,吐出的文字和 LF 换行的一样', () => {
    const crlf = createSseParser()
    const lf = createSseParser()
    const crlfStream = chunk('你').replace(/\n/g, '\r\n') + chunk('好').replace(/\n/g, '\r\n')
    expect(crlf.push(crlfStream)).toEqual(lf.push(chunk('你') + chunk('好')))
  })

  it('CRLF 事件被切成两半到达,先缓冲再吐出', () => {
    const p = createSseParser()
    const whole = chunk('分两次到达').replace(/\n/g, '\r\n')
    const cut = Math.floor(whole.length / 2)
    expect(p.push(whole.slice(0, cut))).toEqual([])
    expect(p.push(whole.slice(cut))).toEqual(['分两次到达'])
  })

  it('分片边界恰好切在 \\r 和 \\n 中间时,不会误判分隔符', () => {
    const p = createSseParser()
    const whole = chunk('边界测试').replace(/\n/g, '\r\n')
    // 切在结尾 \r\n\r\n 里的第三个字符(\r)和第四个字符(\n)之间
    const cut = whole.length - 1
    expect(p.push(whole.slice(0, cut))).toEqual([])
    expect(p.push(whole.slice(cut))).toEqual(['边界测试'])
  })

  it('一条流里混用不同的换行符也能正确解析', () => {
    const p = createSseParser()
    const mixed = chunk('第一条') + chunk('第二条').replace(/\n/g, '\r\n') + chunk('第三条').replace(/\n\n$/, '\r\r')
    expect(p.push(mixed)).toEqual(['第一条', '第二条', '第三条'])
  })

  it('没有分隔符的畸形流持续增长也不会撑爆缓冲区,之后正常的流还能继续解析', () => {
    const p = createSseParser()
    const piece = 'x'.repeat(64 * 1024) // 64KB 一片,不含任何分隔符
    let out: string[] = []
    for (let i = 0; i < 20; i++) {
      // 累计推入超过 1MB,期间应该已经被丢弃过至少一次,不会一直增长
      out = out.concat(p.push(piece))
    }
    // 再单独推入一块超过上限的垃圾,确保不管前面剩了多少都必定触发丢弃
    out = out.concat(p.push('y'.repeat(2 * 1024 * 1024)))
    expect(out).toEqual([])
    // 丢弃之后缓冲区是干净的,正常事件照常解析
    expect(p.push(chunk('恢复正常'))).toEqual(['恢复正常'])
  })
})
