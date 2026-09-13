import type { QuoteRecord } from '@shared/types'
import type { TocItem, VisibleRange } from '../reader/types'
import { estimateTokens } from './tokens'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ContextInput {
  systemPrompt: string
  bookTitle: string
  author: string | null
  visible: VisibleRange
  toc: TocItem[]
  quotes: QuoteRecord[]
  history: ChatMessage[]
  userText: string
  limit: number
}

export type TrimAction = 'toc-local' | 'drop-history' | 'toc-dropped'

export interface ContextResult {
  messages: ChatMessage[]
  trimmed: TrimAction[]
}

/** 目录裁成局部时,当前章节前后各保留几条 */
const TOC_NEIGHBOURS = 5

function tocLines(items: TocItem[]): string {
  return items.map((t) => `${'  '.repeat(t.depth)}- ${t.label}`).join('\n')
}

function localToc(items: TocItem[], chapterHref: string): TocItem[] {
  const bare = (h: string): string => h.split('#')[0]
  const at = items.findIndex((t) => bare(t.href) === bare(chapterHref))
  if (at < 0) return items.slice(0, TOC_NEIGHBOURS * 2 + 1)
  return items.slice(Math.max(0, at - TOC_NEIGHBOURS), at + TOC_NEIGHBOURS + 1)
}

/**
 * 丢掉最早的一轮问答:先丢最前面那条消息,再把紧跟着的 assistant 消息
 * 一并丢掉(可能不止一条)。这样保证:①一问和它对应的答一起消失,不会
 * 只删问题却把孤零零的答案留在最前面;②剩下的历史永远不会以 assistant
 * 开头——有些接口会直接拒绝以 assistant 开头的历史。
 */
function dropOldestExchange(history: ChatMessage[]): ChatMessage[] {
  let rest = history.slice(1)
  while (rest.length > 0 && rest[0].role === 'assistant') {
    rest = rest.slice(1)
  }
  return rest
}

function buildSystem(input: ContextInput, toc: TocItem[] | null, useEnhanced: boolean): string {
  const parts: string[] = [input.systemPrompt, '', `当前阅读的书:《${input.bookTitle}》`]
  if (input.author) parts.push(`作者:${input.author}`)

  // 增强层:目录与当前章节名必须同时可得才一起加入,缺一个就都不加。
  if (useEnhanced && input.visible.chapterLabel) {
    parts.push(`当前章节:${input.visible.chapterLabel}`)
    if (toc && toc.length > 0) {
      parts.push('', '全书目录:', tocLines(toc))
    }
  }

  // approximate 为 true 时 text 是整份章节文档的全文,不是一屏可见内容。
  // 标题必须如实说明,否则模型会把整章当成用户眼前看到的那一小段。
  const heading = input.visible.approximate
    ? '当前章节全文(可见范围跨章,这不是精确的一屏内容):'
    : '当前页内容:'
  parts.push('', heading, input.visible.text)
  return parts.join('\n')
}

function buildUser(input: ContextInput): string {
  if (input.quotes.length === 0) return input.userText
  const quoted = input.quotes.map((q) => `> ${q.text}`).join('\n')
  return `用户划选的原文:\n${quoted}\n\n${input.userText}`
}

function total(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0)
}

/**
 * 按降级策略拼上下文,超限时按固定顺序裁剪。
 *
 * 永不丢弃:系统提示词、书名、作者、当前章节名、当前页正文、本轮引用句子。
 * 裁剪顺序:目录裁成局部 → 删最早的一轮问答 → 目录整个丢掉 → 仍超限则抛错。
 * 最后一步是抛错而不是截断正文:静默截断会让模型看到半句话却毫无察觉,
 * 产生的错误答案从外面看不出任何异常。
 */
export function buildContext(input: ContextInput): ContextResult {
  const trimmed: TrimAction[] = []
  const userMessage: ChatMessage = { role: 'user', content: buildUser(input) }

  // 增强层的前提:目录和章节名同时可得
  const enhanced = input.toc.length > 0 && input.visible.chapterLabel !== null
  let toc: TocItem[] | null = enhanced ? input.toc : null
  let history = [...input.history]

  const assemble = (): ChatMessage[] => [
    { role: 'system', content: buildSystem(input, toc, enhanced) },
    ...history,
    userMessage
  ]

  let messages = assemble()
  if (total(messages) <= input.limit) return { messages, trimmed }

  // ① 目录裁成当前章节前后各 5 条——只要有目录就尝试,裁完真的变小才采用。
  // 不能按目录条数是否超过窗口大小来决定要不要试:哪怕目录只有几条,裁一下
  // 也可能刚好够用,比起跳过这一步直接去删对话历史要划算。
  if (toc) {
    const local = localToc(toc, input.visible.chapterHref)
    if (local.length < toc.length) {
      toc = local
      trimmed.push('toc-local')
      messages = assemble()
      if (total(messages) <= input.limit) return { messages, trimmed }
    }
  }

  // ② 删最早的一轮问答——一问和它对应的答一起删,不是简单删最前面两条
  while (history.length >= 2) {
    history = dropOldestExchange(history)
    if (!trimmed.includes('drop-history')) trimmed.push('drop-history')
    messages = assemble()
    if (total(messages) <= input.limit) return { messages, trimmed }
  }

  // ③ 目录整个丢掉
  if (toc !== null) {
    toc = null
    trimmed.push('toc-dropped')
    messages = assemble()
    if (total(messages) <= input.limit) return { messages, trimmed }
  }

  // ④ 不截断正文,直接告诉用户
  throw new Error('当前页文字量超出模型上下文上限,请调小字号后重试,或在设置里换一个上下文更大的模型')
}
