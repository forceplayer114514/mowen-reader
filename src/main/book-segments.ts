/**
 * 分句批量翻译的纯逻辑（无 Electron/DB 依赖，可单元测试）。
 *
 * 协议：缺失分句按顺序编号，一次模型调用翻译一批（≤ MAX_SEGMENT_BATCH_CHARS），
 * 要求模型逐段编号回译；解析器按“序号递增”严格对齐，段数不符即视为失败。
 */

export const TRANSLATE_SYSTEM_PROMPT =
  '你是书籍翻译助手。用户提供按编号分段的书籍正文（每段一行，以“数字.”开头），请逐段翻译成简体中文。' +
  '保持编号、顺序与段数完全一致，每段译文单独一行、格式与输入相同，只输出编号与译文，不要解释。' +
  '原文已是简体中文的段落直接返回原文。'

export const TRANSLATE_STRICT_PROMPT =
  TRANSLATE_SYSTEM_PROMPT +
  '严格要求：输出行数必须与输入段数相同，每行以相同数字开头，不得合并、拆分或遗漏任何段落。'

/** 用户消息：`1. 分句一\n2. 分句二...`（分句内无换行，一段一行）。 */
export function formatNumberedRequest(segments: string[]): string {
  return segments.map((s, i) => `${i + 1}. ${s}`).join('\n')
}

/** 尾声行标记：模型偶尔在末尾追加的解释性文字，解析时剥离，不污染最后一段译文。 */
const EPILOGUE_PATTERNS = [/^(翻译完毕|翻译完成|以上是|以上为|注\s*[:：])/, /^(好的|完成|Done\b)/i]

function stripEpilogue(lines: string[]): string[] {
  const out = [...lines]
  while (out.length > 0 && EPILOGUE_PATTERNS.some((p) => p.test(out[out.length - 1].trim()))) {
    out.pop()
  }
  return out
}

/**
 * 解析编号回译：返回与输入段数对齐的译文数组（顺序一致），对不齐返回 null。
 *
 * 容忍：开场白（第一段开始前的行）忽略；段内换行续写自动拼接。
 * 严格：编号必须从 1 开始严格递增（防“译文正文恰好以数字开头”误判）；末尾尾声行剥离。
 */
export function parseNumberedTranslations(text: string, expectedCount: number): string[] | null {
  if (!Number.isInteger(expectedCount) || expectedCount <= 0) return null
  const rawLines = stripEpilogue(text.split('\n'))
  const buckets = new Map<number, string[]>()
  let started = false
  let next = 1
  for (const raw of rawLines) {
    const line = raw.trim()
    if (!line) continue
    const match = line.match(/^[\(（]?(\d+)[\)）]?[\.\、:：\s]\s*(.*)$/)
    const num = match ? Number(match[1]) : NaN
    if (match && Number.isInteger(num) && num === next) {
      started = true
      buckets.set(num, match[2] ? [match[2]] : [])
      next++
    } else if (started) {
      buckets.get(next - 1)?.push(line)
    }
    // 未开始前的开场白直接忽略。
  }
  if (buckets.size !== expectedCount) return null
  const out: string[] = []
  for (let i = 1; i <= expectedCount; i++) {
    const parts = buckets.get(i)
    if (!parts) return null
    const joined = parts.join('').trim()
    if (!joined) return null
    out.push(joined)
  }
  return out
}
