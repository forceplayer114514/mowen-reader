/** 本地生词/词句收藏：翻译成功后可选保存，不触发新的 AI/云请求。 */
export interface VocabRecord {
  id: string
  bookId: string
  startCfi: string
  cfiRange: string
  sourceText: string
  translation: string
  chapterLabel: string | null
  createdAt: number
  updatedAt: number
}

export type CreateVocabInput = Omit<VocabRecord, 'id' | 'createdAt' | 'updatedAt'>
