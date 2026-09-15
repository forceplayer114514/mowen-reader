import { classifyHttpError, classifyNetworkError, redactCredentials } from './errors'
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
  /** 仅测试缩短期限;生产请求最多等待一分钟。 */
  timeoutMs?: number
}

const COMPLETIONS_PATH = '/chat/completions'
const REQUEST_TIMEOUT_MS = 60_000

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
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS)
  const signal = AbortSignal.any([options.signal, timeoutSignal])
  const networkMessage = (err: unknown): string =>
    timeoutSignal.aborted && !options.signal.aborted
      ? classifyNetworkError(timeoutSignal.reason)
      : classifyNetworkError(err)

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
      signal
    })
  } catch (err) {
    const message = networkMessage(err)
    if (message === '') return // 用户中止
    throw new Error(message)
  }

  if (!response.ok) {
    let body: string
    try {
      body = await response.text()
    } catch (err) {
      const message = networkMessage(err)
      if (message === '') return
      throw new Error(message)
    }
    // classifyHttpError 传入 apiKey 后,内部已经在截断服务端说明之前打过码;
    // 这里再对拼好的完整消息整体打码一遍,是不依赖 errors.ts 内部顺序的最后
    // 一道保险——即便以后 errors.ts 的实现改了、打码和截断的顺序又被颠倒,
    // 这里仍然兜底,密钥不会漏出去。
    throw new Error(
      redactCredentials(classifyHttpError(response.status, body, options.apiKey), options.apiKey)
    )
  }

  if (!response.body) {
    throw new Error('对方没有返回任何内容')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  try {
    for (;;) {
      if (signal.aborted) break
      const { done, value } = await reader.read()
      if (done) break
      if (signal.aborted) break
      for (const text of parser.push(decoder.decode(value, { stream: true }))) {
        if (signal.aborted) break
        try {
          options.onChunk(text)
        } catch (err) {
          throw new CallbackError(err)
        }
      }
    }
  } catch (err) {
    if (err instanceof CallbackError) {
      // 回调的内容是渲染层给的,今天不会带密钥,但也一律过一遍打码——
      // 不花什么代价,却能拆掉一个以后容易被忘记补上的陷阱。
      throw new Error(
        redactCredentials(`处理时出错(不是网络问题):${describeUnknown(err.cause)}`, options.apiKey)
      )
    }
    const message = networkMessage(err)
    if (message !== '') throw new Error(message)
  } finally {
    parser.done()
    await reader.cancel().catch(() => {})
  }
  if (timeoutSignal.aborted && !options.signal.aborted) {
    throw new Error(classifyNetworkError(timeoutSignal.reason))
  }
}
