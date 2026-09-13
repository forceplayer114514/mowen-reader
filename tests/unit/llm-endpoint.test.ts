import { describe, expect, it } from 'vitest'
import { assertSafeLlmEndpoint } from '../../src/main/llm/endpoint'

describe('接口地址校验', () => {
  it('https 地址放行', () => {
    expect(() => assertSafeLlmEndpoint('https://api.openai.com/v1')).not.toThrow()
  })

  it('面向公网的 http 地址被拒绝', () => {
    expect(() => assertSafeLlmEndpoint('http://api.example.com/v1')).toThrow(/http/)
  })

  it('本机 localhost 的 http 放行', () => {
    expect(() => assertSafeLlmEndpoint('http://localhost:11434/v1')).not.toThrow()
  })

  it('本机 127.0.0.1 的 http 放行', () => {
    expect(() => assertSafeLlmEndpoint('http://127.0.0.1:1234/v1')).not.toThrow()
  })

  it('本机 ::1(IPv6 回环)的 http 放行', () => {
    expect(() => assertSafeLlmEndpoint('http://[::1]:1234/v1')).not.toThrow()
  })

  it('主机名只是以 localhost 开头,不是真正的本机,拒绝', () => {
    expect(() => assertSafeLlmEndpoint('http://localhost.evil.example/v1')).toThrow(/http/)
  })

  it('file: 协议被拒绝', () => {
    expect(() => assertSafeLlmEndpoint('file:///etc/passwd')).toThrow(/https/)
  })

  it('无法解析的字符串被拒绝,报中文说明', () => {
    expect(() => assertSafeLlmEndpoint('不是一个网址')).toThrow(/合法的网址/)
  })
})
