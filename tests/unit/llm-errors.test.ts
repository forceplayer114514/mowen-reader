import { describe, expect, it } from 'vitest'
import {
  classifyHttpError,
  classifyNetworkError,
  redactCredentials
} from '../../src/main/llm/errors'

describe('HTTP 错误分类', () => {
  it('401 说密钥无效', () => {
    expect(classifyHttpError(401, '')).toMatch(/密钥/)
  })

  it('403 说没有权限', () => {
    expect(classifyHttpError(403, '')).toMatch(/权限/)
  })

  it('429 说额度或频率', () => {
    const msg = classifyHttpError(429, '')
    expect(msg).toMatch(/额度|频繁/)
  })

  it('404 说模型名或接口地址填错', () => {
    const msg = classifyHttpError(404, '')
    expect(msg).toMatch(/模型|地址/)
  })

  it('5xx 说是对方服务故障', () => {
    expect(classifyHttpError(503, '')).toMatch(/服务/)
  })

  it('把服务端给的原因附在后面,便于排查', () => {
    const body = JSON.stringify({ error: { message: 'model not found: gtp-4' } })
    expect(classifyHttpError(404, body)).toContain('model not found: gtp-4')
  })

  it('响应体不是 JSON 时不抛错,只给出状态码对应的说法', () => {
    expect(() => classifyHttpError(500, '<html>502 Bad Gateway</html>')).not.toThrow()
    expect(classifyHttpError(500, '<html>')).toMatch(/服务/)
  })

  it('没有单独归类的状态码也给出带状态码的中文说明', () => {
    expect(classifyHttpError(418, '')).toContain('418')
  })

  it('服务端说明超长时会被截断,不会整段塞进提示里', () => {
    const longMessage = 'a'.repeat(2 * 1024 * 1024) // 2MB
    const body = JSON.stringify({ error: { message: longMessage } })
    const msg = classifyHttpError(404, body)
    expect(msg.length).toBeLessThan(1000)
    expect(msg).toContain('...')
    // 中文引导文案必须排在最前面,不会被服务端的灌水内容顶掉
    expect(msg.indexOf('模型名或接口地址填错了')).toBe(0)
  })

  it('服务端说明里的换行和控制字符会被压成空格,不会破坏排版', () => {
    const body = JSON.stringify({ error: { message: '第一行\n第二行\r\n第三行\t带制表符' } })
    const msg = classifyHttpError(404, body)
    expect(msg).not.toMatch(/[\r\n\t]/)
    expect(msg).toContain('第一行 第二行 第三行 带制表符')
  })

  it('服务端说明全是控制字符时,清理完是空的,不会显示空括注', () => {
    const body = JSON.stringify({ error: { message: '\x01\x02\x03' } })
    const msg = classifyHttpError(404, body)
    expect(msg).not.toContain('(')
    expect(msg).not.toContain('服务端说明')
  })

  it('服务端说明全是空白时,清理完是空的,不会显示空括注', () => {
    const body = JSON.stringify({ error: { message: '   \t  ' } })
    const msg = classifyHttpError(404, body)
    expect(msg).not.toContain('(')
    expect(msg).not.toContain('服务端说明')
  })

  it('密钥被服务端回显到第 200 个字符截断边界之后,依旧不会有前缀漏出', () => {
    // 190 个填充字符 + "api_key=" (8 个字符) = 198,真正的密钥从第 198 个
    // 字符开始,跨过 200 字符截断线——先截断再打码的旧顺序会把密钥切成
    // 两半,剩下的前缀就不再等于完整密钥,打码匹配不上,前缀就漏出去了。
    const apiKey = 'sk-supersecret-verylongkey-0123456789'
    const filler = 'x'.repeat(190)
    const body = JSON.stringify({ error: { message: `${filler}api_key=${apiKey}` } })

    const msg = classifyHttpError(404, body, apiKey)

    expect(msg).not.toContain(apiKey)
    // 不能只查完整密钥有没有漏出去,截断点前的任何一段有意义长度的前缀
    // 漏出去也是失败——这正是"先截断再打码"这个旧顺序的错误模式。
    expect(msg).not.toContain(apiKey.slice(0, 10))
  })

  it('不传 apiKey 时,旧的调用方式仍然可用,不受影响', () => {
    expect(() => classifyHttpError(404, JSON.stringify({ error: { message: 'x' } }))).not.toThrow()
  })
})

describe('redactCredentials', () => {
  it('把完整密钥换成 ***', () => {
    expect(redactCredentials('key=sk-abc123', 'sk-abc123')).toBe('key=***')
  })

  it('把 Bearer 后面的一整段也打码,不管是不是当前这次用的密钥', () => {
    expect(redactCredentials('saw Bearer sk-other-999', 'sk-abc123')).toBe('saw Bearer ***')
  })

  it('apiKey 为空串时不报错,原样返回(Bearer 打码仍然生效)', () => {
    expect(redactCredentials('no secrets here', '')).toBe('no secrets here')
  })
})

describe('网络错误分类', () => {
  it('连不上时说检查地址与代理', () => {
    const err = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    expect(classifyNetworkError(err)).toMatch(/连不上|地址/)
  })

  it('域名解析失败单独说明', () => {
    const err = Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } })
    expect(classifyNetworkError(err)).toMatch(/地址/)
  })

  it('超时单独说明', () => {
    const err = Object.assign(new Error('timeout'), { name: 'TimeoutError' })
    expect(classifyNetworkError(err)).toMatch(/超时/)
  })

  it('用户主动中止不算错误', () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' })
    expect(classifyNetworkError(err)).toBe('')
  })

  it('完全不认识的东西也给出中文兜底,不抛错', () => {
    expect(classifyNetworkError('随便一个字符串')).toMatch(/请求失败/)
  })
})
