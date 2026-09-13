/**
 * OpenAI 兼容接口的流式响应解析器。
 *
 * 网络片段可能在任意字节处被切断——一个事件可能被劈成两半,也可能几个事件
 * 挤在同一个片段里。所以必须自己缓冲,只处理已经收到完整空行分隔的部分。
 *
 * 真实服务器发的换行不一定是 \n\n:不少 OpenAI 兼容网关和代理会用 \r\n\r\n,
 * 极少数老式实现还会用 \r\r。三种都要认。
 */

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
      let sep = findSeparator(buffer)
      while (sep !== null) {
        const block = buffer.slice(0, sep.index)
        buffer = buffer.slice(sep.index + sep.length)
        const text = parseEvent(block)
        if (text !== null) out.push(text)
        sep = findSeparator(buffer)
      }
      return out
    },
    done(): void {
      finished = true
      buffer = ''
    }
  }
}
