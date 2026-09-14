export interface BookRecord {
  id: string
  title: string
  author: string | null
  coverPath: string | null
  filePath: string
  sourcePath: string
  addedAt: number
  lastReadCfi: string | null
  lastReadAt: number | null
}

export interface ImportedFile {
  id: string
  filePath: string
}

export interface FinishImportInput {
  id: string
  sourcePath: string
  title: string
  author: string | null
  // 走 ArrayBuffer 而不是 number[]:后者会把一张几百 KB 的封面拆成几十万个
  // JavaScript 数组元素,序列化和跨进程传输的开销随之放大好几倍。
  coverBytes: ArrayBuffer | null
}

export interface ConversationRecord {
  id: string
  bookId: string
  startCfi: string
  endCfi: string
  /** 「合并下一页」时扩展到的终点;没合并过为 null */
  mergedEndCfi: string | null
  chapterLabel: string | null
  /** 该页开头 20 字,供对话管理页辨认 */
  excerpt: string
  createdAt: number
}

export interface QuoteRecord {
  cfiRange: string
  text: string
}

export interface MessageRecord {
  id: string
  conversationId: string
  role: 'user' | 'assistant'
  content: string
  quotes: QuoteRecord[]
  createdAt: number
}

export interface ConversationWithCount extends ConversationRecord {
  messageCount: number
}

export interface ConversationWithBook extends ConversationWithCount {
  bookTitle: string
}

export interface CreateConversationInput {
  bookId: string
  startCfi: string
  endCfi: string
  chapterLabel: string | null
  excerpt: string
}

export interface AppendMessageInput {
  conversationId: string
  role: 'user' | 'assistant'
  content: string
  quotes: QuoteRecord[]
}

export interface StartChatInput {
  messages: { role: string; content: string }[]
}

/**
 * chat:done 事件携带的最终结果。
 *
 * 'finished' 和 'stopped' 分开是必须的:两者在 streamChat 那一侧都是"没有
 * 抛出异常地 resolve",区别只在于 AbortSignal 有没有被触发过——用户主动
 * 点了停止,和模型自己把话说完,界面上应该是完全不同的呈现(比如要不要显示
 * "已停止"字样),不能都用同一个 null 打包糊弄过去。
 */
export type ChatDoneResult =
  | { status: 'finished' }
  | { status: 'stopped' }
  | { status: 'error'; message: string }
