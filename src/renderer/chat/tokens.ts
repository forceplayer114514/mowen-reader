/**
 * 估算一段文字占多少 token。
 *
 * 这是估算不是精确计数:精确计数要为每个厂商装配不同的分词器,对一个
 * 本地阅读器不值得。中日韩文字、中日韩标点和全角/半角形式按每字一个
 * token 计,其余字符按每四个一个计,都是各家分词器的常见量级。在此基础上
 * 再乘以 1.15 并向上取整,作为安全余量——估算方向是往多了算,不是往少了算:
 * 一旦估算偏少,裁剪阶梯会误判"够用了",实际发给接口才被拒绝,用户等到的
 * 就不是体面的裁剪而是一次失败请求。
 */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    const isCjk =
      (code >= 0x3000 && code <= 0x303f) || // 中日韩标点符号
      (code >= 0x3040 && code <= 0x30ff) || // 日文假名
      (code >= 0x3400 && code <= 0x4dbf) || // 中日韩统一表意文字扩展 A
      (code >= 0x4e00 && code <= 0x9fff) || // 基本汉字
      (code >= 0xac00 && code <= 0xd7af) || // 谚文
      (code >= 0xf900 && code <= 0xfaff) || // 兼容汉字
      (code >= 0xff00 && code <= 0xffef) || // 全角/半角形式
      (code >= 0x20000 && code <= 0x2fa1f) // 扩展 B 及以上的表意文字(增补平面)
    if (isCjk) cjk += 1
    else other += 1
  }
  const raw = cjk + Math.ceil(other / 4)
  return Math.ceil(raw * 1.15)
}
