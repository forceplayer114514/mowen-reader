/** 服务端说明展示上限:超过这个长度大概率是灌水或者夹带了不该显示的内容,截断即可。 */
const MAX_SERVER_REASON_LENGTH = 200

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
 */
function sanitizeServerReason(reason: string): string {
  const collapsed = reason.replace(/[\x00-\x1F\x7F]+/g, ' ').trim()
  if (collapsed.length <= MAX_SERVER_REASON_LENGTH) return collapsed
  return `${collapsed.slice(0, MAX_SERVER_REASON_LENGTH)}...`
}

function withReason(base: string, body: string): string {
  const reason = serverReason(body)
  if (!reason) return base
  // 清理之后才能判断是否还有内容——原始消息可能全是控制字符或空白,
  // 清理完就是空串,这种情况不能显示一个空的括注。
  const sanitized = sanitizeServerReason(reason)
  if (!sanitized) return base
  return `${base}(服务端说明:${sanitized})`
}

/**
 * 把 HTTP 状态码翻译成用户能据以行动的中文。
 * 分开说是必须的——这六类问题的解决办法完全不同,统一显示"出错了"
 * 会让用户无从下手。
 */
export function classifyHttpError(status: number, body: string): string {
  if (status === 401) return withReason('API 密钥无效,请到设置里检查', body)
  if (status === 403) return withReason('这个密钥没有访问该模型的权限', body)
  if (status === 429) return withReason('额度用尽或请求过于频繁,稍后再试', body)
  if (status === 404) return withReason('模型名或接口地址填错了,请到设置里检查', body)
  if (status >= 500) return withReason('对方服务故障,稍后重试', body)
  return withReason(`请求失败(HTTP ${status})`, body)
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
