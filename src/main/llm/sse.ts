/**
 * OpenAI 兼容接口的流式响应解析器。
 *
 * 网络片段可能在任意字节处被切断——一个事件可能被劈成两半,也可能几个事件
 * 挤在同一个片段里。所以必须自己缓冲,只处理已经收到完整空行分隔的部分。
 *
 * 真实服务器发的换行不一定是 \n\n:不少 OpenAI 兼容网关和代理会用 \r\n\r\n,
 * 极少数老式实现还会用 \r\r。三种都要认。
 */

/** 单次事件通常只有几 KB;缓冲区超过这个上限还凑不出一个分隔符,说明这段流是坏的。 */
const MAX_BUFFER_SIZE = 1024 * 1024 // 1MB,留足够余量,避免正常大事件被误伤

/** 在 buffer 里找出现得最早的空行分隔符,返回起始位置和分隔符长度。 */
function findSeparator(buffer: string): { index: number; length: number } | null {
  const candidates: { index: number; length: number }[] = [
    { index: buffer.indexOf('\r\n\r\n'), length: 4 },
    { index: buffer.indexOf('\n\n'), length: 2 },
    { index: buffer.indexOf('\r\r'), length: 2 }
  ].filter((c) => c.index >= 0)
  if (candidates.length === 0) return null
  return candidates.reduce((best, c) => (c.index < best.index ? c : best))
}

export function createSseParser(): { push(chunk: string): string[]; done(): void } {
  let buffer = ''
  let finished = false
  // 缓冲区因超限被丢弃之后置位:说明当前 buffer 里剩的、还有之后紧跟着到达
  // 的字节,来源都对不上了,不能再当成正常事件的开头去解析。
  let resyncing = false

  function parseEvent(block: string): string | null {
    for (const rawLine of block.split(/\r\n|\n|\r/)) {
      const line = rawLine.trim()
      if (!line.startsWith('data:')) continue
      const payload = line.slice('data:'.length).trim()
      if (payload === '[DONE]') return null
      try {
        const parsed = JSON.parse(payload) as {
          choices?: { delta?: { content?: string } }[]
        }
        const content = parsed.choices?.[0]?.delta?.content
        if (typeof content === 'string' && content.length > 0) return content
      } catch {
        // 半截或畸形的 JSON:跳过这一行,后面的还要继续
      }
    }
    return null
  }

  return {
    push(chunk: string): string[] {
      if (finished) return []
      buffer += chunk
      const out: string[] = []

      if (resyncing) {
        // 还没等到一个干净的分隔符之前,这些字节都可能是坏流的残余——
        // 不能留着它们,留着就会粘到后面正常事件的前面,把正常事件也拖下水。
        // 一直扔,扔到某次推入里终于凑出一个完整分隔符为止,再继续往下走正常流程。
        if (findSeparator(buffer) === null) {
          buffer = ''
          return out
        }
        resyncing = false
      }

      let sep = findSeparator(buffer)
      while (sep !== null) {
        const block = buffer.slice(0, sep.index)
        buffer = buffer.slice(sep.index + sep.length)
        const text = parseEvent(block)
        if (text !== null) out.push(text)
        sep = findSeparator(buffer)
      }
      // 一直凑不出分隔符,且已经攒了太多字节:这段流是坏的,丢掉重来,
      // 不能让它无限增长把主进程内存吃光。之后进入重新同步状态。
      if (buffer.length > MAX_BUFFER_SIZE) {
        buffer = ''
        resyncing = true
      }
      return out
    },
    done(): void {
      finished = true
      buffer = ''
      resyncing = false
    }
  }
}
