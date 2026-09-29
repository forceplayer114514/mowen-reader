/** 摘录中心 Markdown 导出与文件名清洗:渲染层与主进程共用,保持两端一致。 */

export interface ExcerptMarkdownItem {
  kind: 'highlight' | 'annotation'
  quote: string
  /** 批注正文;高亮没有,为 null */
  note: string | null
  chapterLabel: string | null
  createdAt: number
}

export interface ExcerptMarkdownGroup {
  label: string
  rows: ExcerptMarkdownItem[]
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : `${value}`
}

export function formatExcerptDate(createdAt: number): string {
  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Markdown 特殊字符只做最小转义:标题里的 # 与正文行首的 > / - / 数字. 都加反斜杠。 */
function escapeHeading(text: string): string {
  return text.replace(/[#[\]`*_]/g, (ch) => `\\${ch}`).replace(/\s+/g, ' ').trim() || '未命名'
}

function quoteBlock(quote: string): string {
  const lines = quote.replace(/\r\n/g, '\n').trim().split('\n')
  return lines.map((line) => `> ${line}`).join('\n')
}

/**
 * 按"已分好组、组内已排好序"的结构生成 Markdown。
 * 调用方(ExcerptsView)负责按 CFI 排序与按章节分组,这里只做渲染,
 * 这样主进程将来若改为直接从库生成,复用同一份排版。
 */
export function buildExcerptsMarkdown(
  bookTitle: string,
  author: string | null,
  groups: ExcerptMarkdownGroup[]
): string {
  const rows = groups.flatMap((group) => group.rows)
  const highlights = rows.filter((row) => row.kind === 'highlight').length
  const annotations = rows.filter((row) => row.kind === 'annotation').length
  const lines: string[] = [
    `# 《${escapeHeading(bookTitle || '未命名')}》摘录`,
    '',
    `作者：${author?.trim() ? escapeHeading(author) : '佚名'}`,
    `导出时间：${formatExcerptDate(Date.now())}`,
    `共 ${rows.length} 条（高亮 ${highlights} · 批注 ${annotations}）`,
  ]
  if (rows.length === 0) {
    lines.push('', '暂无摘录。')
    return `${lines.join('\n')}\n`
  }
  for (const group of groups) {
    if (group.rows.length === 0) continue
    lines.push('', `## ${escapeHeading(group.label || '未命名章节')}`, '')
    for (const row of group.rows) {
      lines.push(quoteBlock(row.quote) || '> （原文为空）', '')
      if (row.kind === 'annotation' && row.note?.trim()) {
        lines.push(`批注：${row.note.trim()}`, '')
      } else {
        lines.push(`类型：${row.kind === 'annotation' ? '批注' : '高亮'}`, '')
      }
      const date = formatExcerptDate(row.createdAt)
      if (date) lines.push(`摘录时间：${date}`, '')
      lines.push('---', '')
    }
  }
  return `${lines.join('\n')}\n`
}

/**
 * 把书名变成 save dialog 的默认文件名:去路径分隔符与 Windows 非法字符、
 * 去控制字符,限长,兜底 'excerpts'。返回不带扩展名的基名,
 * 调用方再拼 `.md`。
 */
export function sanitizeExcerptFilename(title: string): string {
  const cleaned = (title || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .slice(0, 80)
    .trim()
  return cleaned || 'excerpts'
}
