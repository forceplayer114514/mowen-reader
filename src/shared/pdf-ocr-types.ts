export interface PdfOcrRegion { x: number; y: number; width: number; height: number }
export type PdfOcrLanguage = 'eng' | 'chi_sim+eng'
export interface PdfOcrWord extends PdfOcrRegion { text: string }
export interface PdfOcrResult {
  id: string
  bookId: string
  page: number
  language: PdfOcrLanguage
  region: PdfOcrRegion | null
  text: string
  words: PdfOcrWord[]
  createdAt: number
}
export interface PdfOcrInput {
  requestId: string
  bookId: string
  page: number
  language: PdfOcrLanguage
  region: PdfOcrRegion | null
  image: ArrayBuffer
}
export interface PdfOcrProgress { requestId: string; status: string; progress: number }
export interface PdfPosition { page: number; x: number; y: number }
