/**
 * 估算一段文字占多少 token。
 *
 * 这是估算不是精确计数:精确计数要为每个厂商装配不同的分词器,对一个
 * 本地阅读器不值得。中日韩文字按每字一个 token 计,其余字符按每四个一个计,
 * 都是各家分词器的常见量级。估算偏保守,真超限了由接口报错兜底,
 * 走错误分类那条路。
 */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    const isCjk =
      (code >= 0x3040 && code <= 0x30ff) || // 日文假名
      (code >= 0x3400 && code <= 0x4dbf) || // 扩展 A
      (code >= 0x4e00 && code <= 0x9fff) || // 基本汉字
      (code >= 0xf900 && code <= 0xfaff) || // 兼容汉字
      (code >= 0xac00 && code <= 0xd7af) // 谚文
    if (isCjk) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / 4)
}
