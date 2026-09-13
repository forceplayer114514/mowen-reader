import { describe, expect, it } from 'vitest'
import { createSessionRegistry } from '../../src/main/llm/session'

describe('请求会话登记', () => {
  it('开始一个请求会拿到唯一 id', () => {
    const reg = createSessionRegistry()
    const a = reg.start()
    const b = reg.start()
    expect(a.id).not.toBe(b.id)
  })

  it('新开的请求没有被中止', () => {
    const reg = createSessionRegistry()
    expect(reg.start().signal.aborted).toBe(false)
  })

  it('按 id 中止会让对应的信号变为已中止', () => {
    const reg = createSessionRegistry()
    const s = reg.start()
    reg.abort(s.id)
    expect(s.signal.aborted).toBe(true)
  })

  it('中止一个请求不影响另一个', () => {
    const reg = createSessionRegistry()
    const a = reg.start()
    const b = reg.start()
    reg.abort(a.id)
    expect(b.signal.aborted).toBe(false)
  })

  it('中止不存在的 id 不报错', () => {
    const reg = createSessionRegistry()
    expect(() => reg.abort('没有这个')).not.toThrow()
  })

  it('结束后再中止同一个 id 不报错', () => {
    const reg = createSessionRegistry()
    const s = reg.start()
    reg.finish(s.id)
    expect(() => reg.abort(s.id)).not.toThrow()
  })

  it('结束会把请求从登记表里移除', () => {
    const reg = createSessionRegistry()
    const s = reg.start()
    expect(reg.size()).toBe(1)
    reg.finish(s.id)
    expect(reg.size()).toBe(0)
  })

  it('abortAll 中止全部并清空登记表', () => {
    const reg = createSessionRegistry()
    const a = reg.start()
    const b = reg.start()
    reg.abortAll()
    expect(a.signal.aborted).toBe(true)
    expect(b.signal.aborted).toBe(true)
    expect(reg.size()).toBe(0)
  })
})
