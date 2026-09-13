import { describe, expect, it } from 'vitest'
import {
  assertKeyBoundToEndpoint,
  assertSafeLlmEndpoint,
  llmEndpointHost
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

describe('接口地址的主机名', () => {
  it('取出主机名', () => {
    expect(llmEndpointHost('https://api.openai.com/v1')).toBe('api.openai.com')
  })

  it('端口是主机名的一部分:同一台机器的不同端口是不同的服务', () => {
    expect(llmEndpointHost('http://127.0.0.1:1234/v1')).toBe('127.0.0.1:1234')
    expect(llmEndpointHost('http://127.0.0.1:11434/v1')).not.toBe(
      llmEndpointHost('http://127.0.0.1:1234/v1')
    )
  })

  it('大小写不同的同一个主机名算同一个', () => {
    expect(llmEndpointHost('https://API.OpenAI.com/v1')).toBe(
      llmEndpointHost('https://api.openai.com/v1')
    )
  })

  it('路径和查询串不影响主机名', () => {
    expect(llmEndpointHost('https://api.openai.com/v1/chat/completions?x=1')).toBe(
      'api.openai.com'
    )
  })

  it('不是合法网址时抛中文错误', () => {
    expect(() => llmEndpointHost('不是一个网址')).toThrow(/合法的网址/)
  })
})

describe('密钥与填写它时的接口地址绑定', () => {
  it('地址没变,放行', () => {
    expect(() =>
      assertKeyBoundToEndpoint('api.openai.com', 'https://api.openai.com/v1')
    ).not.toThrow()
  })

  it('换了主机名就拒绝,并把两个地址都说清楚', () => {
    expect(() => assertKeyBoundToEndpoint('api.openai.com', 'https://evil.example/v1')).toThrow(
      /evil\.example/
    )
    expect(() => assertKeyBoundToEndpoint('api.openai.com', 'https://evil.example/v1')).toThrow(
      /api\.openai\.com/
    )
  })

  it('只是换了端口也拒绝', () => {
    expect(() =>
      assertKeyBoundToEndpoint('127.0.0.1:1234', 'http://127.0.0.1:11434/v1')
    ).toThrow(/重新填写/)
  })

  it('路径变了但主机没变,放行', () => {
    expect(() =>
      assertKeyBoundToEndpoint('api.openai.com', 'https://api.openai.com/v1/chat/completions')
    ).not.toThrow()
  })

  it('旧版本存下的、没有记录地址的密钥,一律要求重新填写', () => {
    expect(() => assertKeyBoundToEndpoint(null, 'https://api.openai.com/v1')).toThrow(/重新填写/)
  })
})
