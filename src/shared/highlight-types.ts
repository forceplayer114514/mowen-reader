/** 持久荧光笔高亮:按 CFI 范围持久化,不碰分页与正文 DOM。 */
export interface HighlightRecord {
  id: string
  bookId: string
  cfiRange: string
  startCfi: string
  quote: string
  createdAt: number
}

export type CreateHighlightInput = Omit<HighlightRecord, 'id' | 'createdAt'>
