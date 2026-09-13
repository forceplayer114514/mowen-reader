/** 服务端说明展示上限:超过这个长度大概率是灌水或者夹带了不该显示的内容,截断即可。 */
const MAX_SERVER_REASON_LENGTH = 200

/**
 * 服务端的错误文本可能把请求头(含密钥)原样回显,甚至回显别的凭证。
 * 用在这里、也用在 client.ts 里——两处都要过一遍这个函数:先把真实密钥的
 * 每一处出现都换掉,再把任何"Bearer 一串不含空白的字符"形状的片段也换掉,
 * 防止密钥以别的形式,或者别的凭证,从服务端说明里露出去。
 *
 * 必须在这里(拼进最终提示、被截断之前)先跑一遍,不能只指望 client.ts 那边
 * 最后再打码一次:密钥如果正好落在第 200 个字符附近,会被截断切成两半,
 * 切完剩下的前缀已经不再是完整的 apiKey 字符串,client.ts 那边的
 * `message.split(apiKey)` 就再也匹配不上,前缀就会带着漏出去。所以打码
 * 必须先于截断——这个函数把两件事按正确的顺序串起来。
 */
export function redactCredentials(message: string, apiKey: string): string {
  let out = message
  if (apiKey.length > 0) {
    out = out.split(apiKey).join('***')
  }
  return out.replace(/Bearer\s+\S+/gi, 'Bearer ***')
}

/** 尽力从服务端响应体里挖出可读的原因,挖不到就返回空串。 */
function serverReason(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string }
    const reason = parsed.error?.message ?? parsed.message
    return typeof reason === 'string' && reason.length > 0 ? reason : ''
  } catch {
    return ''
  }
}

/**
 * 服务端的原始消息不可信:可能带换行、控制字符,甚至几 MB 长。
 * 先把控制字符(含换行)压成空格防止破坏排版,再限制长度防止把界面撑爆。
 * 调用方必须保证传进来之前已经打过码——这个函数只管排版,不管敏感内容。
 */
function sanitizeServerReason(reason: string): string {
  const collapsed = reason.replace(/[\x00-\x1F\x7F]+/g, ' ').trim()
  if (collapsed.length <= MAX_SERVER_REASON_LENGTH) return collapsed
  return `${collapsed.slice(0, MAX_SERVER_REASON_LENGTH)}...`
}

function withReason(base: string, body: string, apiKey: string): string {
  const reason = serverReason(body)
  if (!reason) return base
  // 顺序是关键:先打码,再截断。反过来的话,密钥如果正好跨在截断边界上,
  // 剩下的前缀就不再等于完整密钥,打码会失效,详见 redactCredentials 的注释。
  const redacted = redactCredentials(reason, apiKey)
  // 清理之后才能判断是否还有内容——原始消息可能全是控制字符或空白,
  // 清理完就是空串,这种情况不能显示一个空的括注。
  const sanitized = sanitizeServerReason(redacted)
  if (!sanitized) return base
  return `${base}(服务端说明:${sanitized})`
}

/**
 * 把 HTTP 状态码翻译成用户能据以行动的中文。
 * 分开说是必须的——这六类问题的解决办法完全不同,统一显示"出错了"
 * 会让用户无从下手。
 *
 * apiKey 默认为空串,只在需要过滤凭证时(client.ts 调用时)传入;
 * 现有直接调用 classifyHttpError(status, body) 的调用方不受影响——
 * 即便不传 apiKey,"Bearer ***" 这一层打码依然生效。
 */
export function classifyHttpError(status: number, body: string, apiKey = ''): string {
  if (status === 401) return withReason('API 密钥无效,请到设置里检查', body, apiKey)
  if (status === 403) return withReason('这个密钥没有访问该模型的权限', body, apiKey)
  if (status === 429) return withReason('额度用尽或请求过于频繁,稍后再试', body, apiKey)
  if (status === 404) return withReason('模型名或接口地址填错了,请到设置里检查', body, apiKey)
  if (status >= 500) return withReason('对方服务故障,稍后重试', body, apiKey)
  return withReason(`请求失败(HTTP ${status})`, body, apiKey)
}

/** 把 fetch 层抛出的东西翻译成中文。用户主动中止返回空串——那不是错误。 */
export function classifyNetworkError(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const e = err as { name?: string; cause?: { code?: string } }
    if (e.name === 'AbortError') return ''
    if (e.name === 'TimeoutError') return '请求超时,对方一直没有回应'
    const code = e.cause?.code
    if (code === 'ECONNREFUSED') return '连不上服务器,请检查接口地址与代理设置'
    if (code === 'ENOTFOUND') return '接口地址解析不到,请检查是否填错'
    if (code === 'ETIMEDOUT') return '请求超时,对方一直没有回应'
  }
  return '请求失败,请检查网络与接口地址'
}
