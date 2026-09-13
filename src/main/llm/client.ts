import { classifyHttpError, classifyNetworkError } from './errors'
import { createSseParser } from './sse'

export interface StreamOptions {
  endpoint: string
  model: string
  apiKey: string
  messages: { role: string; content: string }[]
  signal: AbortSignal
  onChunk: (text: string) => void
  /** 仅测试注入;缺省用全局 fetch */
  fetchImpl?: typeof fetch
}

const COMPLETIONS_PATH = '/chat/completions'

/**
 * 拼出实际请求地址。
 *
 * 优先用 URL API 解析:地址本身已经以 /chat/completions 结尾就原样使用
 * (避免重复拼接),否则只在路径部分追加,查询串和 fragment 原样保留
 * (Azure 风格的 ?api-version=... 不会被路径追加破坏)。
 * 用户填的地址可能压根不是合法 URL(比如漏填协议头),这种输入不该让程序
 * 崩掉,所以解析失败时退回原来的字符串拼接方式。
 */
function chatUrl(endpoint: string): string {
  try {
    const url = new URL(endpoint)
    if (!url.pathname.endsWith(COMPLETIONS_PATH)) {
      url.pathname = `${url.pathname.replace(/\/+$/, '')}${COMPLETIONS_PATH}`
    }
    return url.toString()
  } catch {
    const stripped = endpoint.replace(/\/+$/, '')
    if (stripped.endsWith(COMPLETIONS_PATH)) return stripped
    return `${stripped}${COMPLETIONS_PATH}`
  }
}

/**
 * 服务端返回的错误文本可能把请求头(含密钥)原样回显,甚至回显别的凭证。
 * 抛出之前一律过一遍这个函数:先把真实密钥的每一处出现都换掉,再把任何
 * "Bearer 一串不含空白的字符"形状的片段也换掉,防止密钥以别的形式,或者
 * 别的凭证,从服务端说明里露出去。
 */
function redactCredentials(message: string, apiKey: string): string {
  let out = message
  if (apiKey.length > 0) {
    out = out.split(apiKey).join('***')
  }
  return out.replace(/Bearer\s+\S+/gi, 'Bearer ***')
}

/** 用 onChunk 自己的异常把网络异常路径区分开,不让两者混在一起被误判成网络问题。 */
class CallbackError extends Error {
  constructor(public readonly cause: unknown) {
    super('回调出错')
  }
}

function describeUnknown(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 向 OpenAI 兼容接口发起流式请求。
 *
 * 抛出的 Error 的 message 一律已经是可读中文——界面直接显示即可,不需要
 * 再做二次翻译。密钥只在这里进入请求头,绝不会出现在任何错误信息里。
 * 用户主动中止不算失败,正常 resolve,已经收到的文字块保留。
 */
export async function streamChat(options: StreamOptions): Promise<void> {
  const doFetch = options.fetchImpl ?? fetch
  const parser = createSseParser()

  let response: Response
  try {
    response = await doFetch(chatUrl(options.endpoint), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.apiKey}`
      },
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        stream: true
      }),
      signal: options.signal
    })
  } catch (err) {
    const message = classifyNetworkError(err)
    if (message === '') return // 用户中止
    throw new Error(message)
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(redactCredentials(classifyHttpError(response.status, body), options.apiKey))
  }

  if (!response.body) {
    throw new Error('对方没有返回任何内容')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  try {
    for (;;) {
      if (options.signal.aborted) break
      const { done, value } = await reader.read()
      if (done) break
      if (options.signal.aborted) break
      for (const text of parser.push(decoder.decode(value, { stream: true }))) {
        if (options.signal.aborted) break
        try {
          options.onChunk(text)
        } catch (err) {
          throw new CallbackError(err)
        }
      }
    }
  } catch (err) {
    if (err instanceof CallbackError) {
      throw new Error(`处理时出错(不是网络问题):${describeUnknown(err.cause)}`)
    }
    const message = classifyNetworkError(err)
    if (message !== '') throw new Error(message)
  } finally {
    parser.done()
    await reader.cancel().catch(() => {})
  }
}
