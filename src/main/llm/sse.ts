/**
 * OpenAI 兼容接口的流式响应解析器。
 *
 * 网络片段可能在任意字节处被切断——一个事件可能被劈成两半,也可能几个事件
 * 挤在同一个片段里。所以必须自己缓冲,只处理已经收到完整空行分隔的部分。
 */
export function createSseParser(): { push(chunk: string): string[]; done(): void } {
  let buffer = ''
  let finished = false

  function parseEvent(block: string): string | null {
    for (const rawLine of block.split('\n')) {
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
      let cut = buffer.indexOf('\n\n')
      while (cut >= 0) {
        const block = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 2)
        const text = parseEvent(block)
        if (text !== null) out.push(text)
        cut = buffer.indexOf('\n\n')
      }
      return out
    },
    done(): void {
      finished = true
      buffer = ''
    }
  }
}
