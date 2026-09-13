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

/**
 * 取出接口地址的主机名,含端口。
 *
 * 用 URL 的 `host` 而不是 `hostname`:同一台机器上不同端口跑的是不同的服务
 * (本地 11434 是 Ollama、1234 可能是别的东西),把端口丢掉就等于认为它们
 * 是同一个收件人。`host` 只在端口是该协议默认端口时才省略端口,
 * `https://a.com` 和 `https://a.com:443` 因此仍然算同一个,这是对的。
 * URL 解析本身会把主机名统一成小写,大小写不同的同一个域名不会被当成两个。
 */
export function llmEndpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host
  } catch {
    throw new Error(`接口地址填的不是一个合法的网址,请到设置里检查:${endpoint}`)
  }
}

/**
 * 核对"密钥当初是为哪个地址填的"和"这次要发往哪个地址"是否是同一个收件人。
 *
 * 只校验 https 拦不住真正的问题:证书是免费的,攻击者的地址一样可以是
 * https。被攻破的渲染层只要把 `llmEndpoint` 改成自己的地址,主进程就会
 * 老老实实地解密真实密钥、以 `Authorization: Bearer <明文>` 送过去。
 * 所以密钥落盘时会连同"当时设置里的接口地址主机名"一起加密保存(见
 * secrets.ts),这里在密钥被交给请求之前比一次:对不上就拒绝。
 *
 * 渲染层能单独改的只有设置表里的 `llmEndpoint`,改不了加密文件里记下的那个
 * 主机名——要换那个主机名,必须走 `secrets:setApiKey` 重新输入一次密钥,
 * 而密钥它并不知道。于是这条攻击链的结果从"密钥被送走"变成"用户看到一句
 * '接口地址变了',而这个改动并不是用户自己做的"。
 *
 * storedHost 为 null 表示这份密钥是更早的版本存下的、没有记下地址。这种
 * 情况一律拒绝而不是放行:放行等于给所有升级上来的用户留着原来那个洞,
 * 而"把它当作绑定到当前地址"更糟——当前地址正可能就是攻击者刚写进去的。
 * 代价只是用户重新输入一次密钥。
 */
export function assertKeyBoundToEndpoint(storedHost: string | null, endpoint: string): void {
  const current = llmEndpointHost(endpoint)
  if (storedHost === null) {
    throw new Error(
      '保存的 API 密钥是旧版本存下的,没有记录它当初是填给哪个接口地址的。' +
        '为了不把密钥发到不该去的地方,请到设置里重新填写一次 API 密钥。'
    )
  }
  if (storedHost !== current) {
    throw new Error(
      `接口地址现在是 ${current},而 API 密钥当初是填给 ${storedHost} 的,两者对不上,` +
        `这次请求已经取消。如果这个地址不是你自己改的,请检查设置;` +
        `确实要换到新地址,请到设置里重新填写一次 API 密钥。`
    )
  }
}
