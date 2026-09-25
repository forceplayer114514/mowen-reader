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

export interface ListModelsOptions {
  endpoint: string
  apiKey: string
  /** 仅测试注入;缺省用全局 fetch */
  fetchImpl?: typeof fetch
  /** 仅测试缩短期限;生产请求最多等待十五秒。 */
  timeoutMs?: number
}

export interface ModelsResult {
  models: string[]
  /** 实际可用的 OpenAI 兼容基址；通常与用户填写的一致。 */
  endpoint: string
}

const COMPLETIONS_PATH = '/chat/completions'
const REQUEST_TIMEOUT_MS = 60_000
const MODELS_TIMEOUT_MS = 15_000

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

function modelsUrl(endpoint: string): string {
  try {
    const url = new URL(endpoint)
    if (url.pathname.endsWith(COMPLETIONS_PATH)) {
      url.pathname = `${url.pathname.slice(0, -COMPLETIONS_PATH.length)}/models`
    } else if (!url.pathname.endsWith('/models')) {
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/models`
    }
    return url.toString()
  } catch {
    const stripped = endpoint.replace(/\/+$/, '')
    if (stripped.endsWith(COMPLETIONS_PATH)) {
      return `${stripped.slice(0, -COMPLETIONS_PATH.length)}/models`
    }
    return stripped.endsWith('/models') ? stripped : `${stripped}/models`
  }
}

/** 用 onChunk 自己的异常把网络异常路径区分开,不让两者混在一起被误判成网络问题。 */
class CallbackError extends Error {
  constructor(public readonly cause: unknown) {
    super('回调出错')
  }
}

class HtmlModelsResponse extends Error {}

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

  const request = (endpoint: string): Promise<Response> => doFetch(chatUrl(endpoint), {
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

  let response: Response
  try {
    response = await request(options.endpoint)
    const fallback = rootV1Endpoint(options.endpoint)
    if (fallback && response.headers.get('content-type')?.includes('text/html')) {
      response = await request(fallback)
    }
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

async function listModelsAt(options: ListModelsOptions, endpoint: string): Promise<string[]> {
  const doFetch = options.fetchImpl ?? fetch
  const signal = AbortSignal.timeout(options.timeoutMs ?? MODELS_TIMEOUT_MS)
  const networkMessage = (error: unknown): string =>
    classifyNetworkError(signal.aborted ? signal.reason : error)
  let response: Response
  try {
    response = await doFetch(modelsUrl(endpoint), {
      headers: { Authorization: `Bearer ${options.apiKey}` },
      signal
    })
  } catch (error) {
    throw new Error(networkMessage(error) || '获取模型已停止')
  }

  let body: string
  try {
    body = await response.text()
  } catch (error) {
    throw new Error(networkMessage(error) || '获取模型已停止')
  }
  if (!response.ok) {
    throw new Error(
      redactCredentials(classifyHttpError(response.status, body, options.apiKey), options.apiKey)
    )
  }

  if (response.headers.get('content-type')?.includes('text/html') && /^\s*</.test(body)) {
    throw new HtmlModelsResponse()
  }

  try {
    const parsed = JSON.parse(body) as { data?: { id?: unknown }[] }
    const models = [...new Set(
      (Array.isArray(parsed.data) ? parsed.data : [])
        .map((item) => item?.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
    )]
    if (models.length === 0) throw new Error()
    return models
  } catch {
    throw new Error('接口返回的模型列表格式不正确')
  }
}

function rootV1Endpoint(endpoint: string): string | null {
  try {
    const url = new URL(endpoint)
    const current = url.pathname.replace(/\/+$/, '')
    if (current === '/v1') return null
    url.pathname = '/v1'
    return url.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

/** 从 OpenAI 兼容接口读取模型 id；密钥仍只存在于主进程。 */
export async function listModels(options: ListModelsOptions): Promise<ModelsResult> {
  try {
    return { models: await listModelsAt(options, options.endpoint), endpoint: options.endpoint }
  } catch (error) {
    const fallback = rootV1Endpoint(options.endpoint)
    if (!(error instanceof HtmlModelsResponse) || !fallback) throw error
    return { models: await listModelsAt(options, fallback), endpoint: fallback }
  }
}
