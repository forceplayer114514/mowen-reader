import { describe, expect, it } from 'vitest'
import {
  assertKeyBoundToEndpoint,
  assertSafeLlmEndpoint,
  llmEndpointOrigin
} from '../../src/main/llm/endpoint'

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

describe('接口地址的来源', () => {
  it('取出协议 + 主机名', () => {
    expect(llmEndpointOrigin('https://api.openai.com/v1')).toBe('https://api.openai.com')
  })

  it('端口是来源的一部分:同一台机器的不同端口是不同的服务', () => {
    expect(llmEndpointOrigin('http://127.0.0.1:1234/v1')).toBe('http://127.0.0.1:1234')
    expect(llmEndpointOrigin('http://127.0.0.1:11434/v1')).not.toBe(
      llmEndpointOrigin('http://127.0.0.1:1234/v1')
    )
  })

  it('大小写不同的同一个主机名算同一个', () => {
    expect(llmEndpointOrigin('https://API.OpenAI.com/v1')).toBe(
      llmEndpointOrigin('https://api.openai.com/v1')
    )
  })

  it('路径和查询串不影响来源', () => {
    expect(llmEndpointOrigin('https://api.openai.com/v1/chat/completions?x=1')).toBe(
      'https://api.openai.com'
    )
  })

  it('协议是来源的一部分:本机 https 的 443 和 http 的 80 不算同一个', () => {
    // 只记主机名的话两边都是 `localhost`,两个毫不相干的服务会塌缩成一个。
    expect(llmEndpointOrigin('https://localhost:443/v1')).not.toBe(
      llmEndpointOrigin('http://localhost:80/v1')
    )
  })

  it('不是合法网址时抛中文错误', () => {
    expect(() => llmEndpointOrigin('不是一个网址')).toThrow(/合法的网址/)
  })
})

describe('密钥与填写它时的接口地址绑定', () => {
  it('地址没变,放行', () => {
    expect(() =>
      assertKeyBoundToEndpoint('https://api.openai.com', 'https://api.openai.com/v1')
    ).not.toThrow()
  })

  it('换了主机名就拒绝,并把两个地址都说清楚', () => {
    expect(() =>
      assertKeyBoundToEndpoint('https://api.openai.com', 'https://evil.example/v1')
    ).toThrow(/evil\.example/)
    expect(() =>
      assertKeyBoundToEndpoint('https://api.openai.com', 'https://evil.example/v1')
    ).toThrow(/api\.openai\.com/)
  })

  it('本机上只是从 https 的 443 换成 http 的 80,也拒绝', () => {
    // 协议校验放行(回环地址允许 http),地址比对是这里唯一的闸门:如果只比
    // 主机名,两边都是 `localhost`,密钥就会以明文 HTTP 送到本机 80 端口上
    // 监听的任何东西。
    expect(() => assertKeyBoundToEndpoint('https://localhost', 'http://localhost/v1')).toThrow(
      /重新填写/
    )
  })

  it('只是换了端口也拒绝', () => {
    expect(() =>
      assertKeyBoundToEndpoint('http://127.0.0.1:1234', 'http://127.0.0.1:11434/v1')
    ).toThrow(/重新填写/)
  })

  it('路径变了但来源没变,放行', () => {
    expect(() =>
      assertKeyBoundToEndpoint(
        'https://api.openai.com',
        'https://api.openai.com/v1/chat/completions'
      )
    ).not.toThrow()
  })

  it('旧版本存下的、没有记录地址的密钥,一律要求重新填写', () => {
    expect(() => assertKeyBoundToEndpoint(null, 'https://api.openai.com/v1')).toThrow(/重新填写/)
  })
})
