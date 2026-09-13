/**
 * 只允许本机(回环地址)使用 http,其余一律要求 https。
 * 精确匹配这三种写法,不做前缀或域名后缀匹配——`localhost.evil.example`
 * 不能因为“看起来像”本机就被放过。
 *
 * Node 的 URL 解析会给 IPv6 主机名保留一对方括号(`new
 * URL('http://[::1]/').hostname === '[::1]'`,不是 `::1`),所以这里两种
 * 写法都收进集合,不能只收裸的 `::1`。
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/**
 * 校验渲染层写进设置里的接口地址,在 chat:start 里、密钥被取出之前调用。
 *
 * 背景:`settings:set` 通道对渲染层来说没有白名单,一个被攻破的渲染层可以把
 * `llmEndpoint` 改成任意地址。地址本身不能决定密钥去不去——密钥是主进程按
 * 这个地址发出请求时才附上的——所以校验必须放在真正发请求之前的这一步,
 * 而不是 settings:set 里(那里改了值本身没有危害,危害发生在密钥被这个值
 * 引导着送出去的那一刻)。
 *
 * 规则:
 * - 地址必须能被解析成合法 URL,解析不了直接拒绝。
 * - `https:` 一律放行。
 * - `http:` 只在目标主机是本机回环地址时放行,方便接本地跑的模型服务
 *   (它们通常没有证书)。
 * - 其余协议(包括 `file:`)和面向公网的 `http:` 一律拒绝。
 *
 * 校验通过什么都不返回;不通过则抛出 Error,message 已经是可以直接展示给
 * 用户的中文,说明具体是这个地址的什么问题。
 */
export function assertSafeLlmEndpoint(endpoint: string): void {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new Error(`接口地址填的不是一个合法的网址,请到设置里检查:${endpoint}`)
  }

  if (url.protocol === 'https:') return

  if (url.protocol === 'http:') {
    if (LOOPBACK_HOSTS.has(url.hostname)) return
    throw new Error(
      `接口地址不能用 http 发到非本机地址(${url.hostname}),密钥会被明文发送,` +
        `请改成 https 开头的地址,或者把地址换成本机的 localhost / 127.0.0.1`
    )
  }

  throw new Error(`接口地址必须是 https 开头,当前是 ${url.protocol} 开头,请到设置里改正`)
}
