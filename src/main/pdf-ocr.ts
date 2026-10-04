import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { PdfOcrInput, PdfOcrProgress, PdfOcrRegion, PdfOcrResult, PdfOcrWord, PdfPosition } from '../shared/pdf-ocr-types'
import { bookFormat } from '../shared/book-format'
import { getBook } from './db/books'
import { cachedPdfOcr, savePdfOcr } from './db/pdf-ocr'
import type { Db } from './db'

export function validatePdfBook(db: Db, bookId: unknown): asserts bookId is string {
  if (typeof bookId !== 'string' || !bookId || bookId.length > 200) throw new Error('PDF 书籍无效')
  const book = getBook(db, bookId)
  if (!book || bookFormat(book.filePath) !== 'pdf') throw new Error('PDF 书籍不存在')
}
export function validatePdfPage(page: unknown): asserts page is number {
  if (!Number.isInteger(page) || (page as number) < 1 || (page as number) > 100000) throw new Error('PDF 页码无效')
}
export function normalizePdfPosition(input: PdfPosition): PdfPosition {
  if (!input || typeof input !== 'object') throw new Error('PDF 阅读位置无效')
  validatePdfPage(input.page)
  if (!Number.isFinite(input.x) || !Number.isFinite(input.y)) throw new Error('PDF 阅读位置无效')
  return { page: input.page, x: Math.min(1, Math.max(0, input.x)), y: Math.min(1, Math.max(0, input.y)) }
}
export function validatePdfOcr(input: PdfOcrInput): { width: number; height: number; key: string } {
  if (!input || typeof input !== 'object' || typeof input.requestId !== 'string' ||
    !/^[\w-]{1,128}$/.test(input.requestId)) throw new Error('OCR 请求无效')
  validatePdfPage(input.page)
  if (input.language !== 'eng' && input.language !== 'chi_sim+eng') throw new Error('OCR 语言无效')
  const r = input.region
  if (r !== null && (!r || typeof r !== 'object' || ![r.x, r.y, r.width, r.height].every(Number.isFinite) ||
    r.x < 0 || r.y < 0 || r.width <= 0 || r.height <= 0 || r.x + r.width > 1.000001 || r.y + r.height > 1.000001)) {
    throw new Error('OCR 选区无效，请重新框选')
  }
  if (!(input.image instanceof ArrayBuffer) || input.image.byteLength < 33 || input.image.byteLength > 64 * 1024 * 1024) {
    throw new Error('OCR 图片无效或过大，请缩小识别区域')
  }
  const bytes = Buffer.from(input.image)
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('OCR 仅接受本地书页 PNG 图片')
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
  if (!width || !height || width > 16384 || height > 16384 || width * height > 16_000_000) {
    throw new Error('OCR 图片分辨率过大，请缩小识别区域')
  }
  // Full-page text indices remain stable even if display DPI/zoom changes later.
  const key = r === null ? `full:${input.language}` : createHash('sha256')
    .update(input.language).update(JSON.stringify(r)).update(bytes).digest('hex')
  return { width, height, key }
}

export function normalizeOcrWords(words: Array<{ text: string; bbox: { x0: number; y0: number; x1: number; y1: number } }>,
  width: number, height: number, region: PdfOcrRegion | null): PdfOcrWord[] {
  const r = region ?? { x: 0, y: 0, width: 1, height: 1 }
  const result: PdfOcrWord[] = []
  for (const word of words) {
    if (result.length >= 50000) break
    const box = word.bbox
    if (!word.text?.trim() || !box || ![box.x0, box.x1, box.y0, box.y1].every(Number.isFinite)) continue
    const x0 = Math.max(0, Math.min(width, box.x0)), x1 = Math.max(0, Math.min(width, box.x1))
    const y0 = Math.max(0, Math.min(height, box.y0)), y1 = Math.max(0, Math.min(height, box.y1))
    if (x1 <= x0 || y1 <= y0) continue
    result.push({ text: word.text.slice(0, 2000), x: r.x + x0 / width * r.width,
      y: r.y + y0 / height * r.height, width: (x1 - x0) / width * r.width, height: (y1 - y0) / height * r.height })
  }
  return result
}

interface ActiveJob { owner: number; id: string; cancel: () => Promise<void> }
export class PdfOcrService {
  private active: ActiveJob | null = null
  constructor(private options: { database: () => Db; workerPath: string; modelDir: string;
    workerFactory?: (path: string) => Worker; timeout?: number }) {}

  async recognize(input: PdfOcrInput, owner: number, progress: (event: PdfOcrProgress) => void): Promise<PdfOcrResult> {
    const info = validatePdfOcr(input), db = this.options.database()
    validatePdfBook(db, input.bookId)
    const cached = cachedPdfOcr(db, input.bookId, input.page, info.key)
    if (cached) return cached
    if (this.active) throw new Error('已有书页正在识别，请等待或先取消')
    // Claim before asynchronous setup so simultaneous requests cannot allocate two WASM engines.
    let canceled = false
    this.active = { owner, id: input.requestId, cancel: async () => { canceled = true } }
    let tempDir: string | null = null
    let termination: Promise<number> | null = null
    try {
      await mkdir(this.options.modelDir, { recursive: true })
      tempDir = await mkdtemp(join(this.options.modelDir, '.download-'))
      if (canceled) throw new Error('已取消识别')
      const worker = this.options.workerFactory?.(this.options.workerPath) ?? new Worker(this.options.workerPath)
      const result = await new Promise<{ text: string; words: PdfOcrWord[] }>((resolve, reject) => {
        let settled = false
        const finish = (error?: Error, value?: { text: string; words: PdfOcrWord[] }): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          worker.removeAllListeners()
          termination = worker.terminate().catch(() => 0)
          if (error) reject(error)
          else resolve(value!)
        }
        const timer = setTimeout(() => finish(new Error('OCR 超时，请检查网络或尝试较小选区')), this.options.timeout ?? 240000)
        this.active = { owner, id: input.requestId, cancel: async () => {
          finish(new Error('已取消识别'))
          await termination
        } }
        worker.on('error', () => finish(new Error('本地 OCR 引擎未能启动，请重试')))
        worker.on('exit', () => finish(new Error('本地 OCR 引擎意外退出，请重试')))
        worker.on('message', (message: { type: string; status?: string; progress?: number; text?: string; words?: PdfOcrWord[] }) => {
          if (settled) return
          if (message.type === 'progress') {
            progress({ requestId: input.requestId, status: message.status ?? '识别中', progress: Math.min(1, Math.max(0, message.progress ?? 0)) })
          } else if (message.type === 'result') {
            if (typeof message.text !== 'string' || message.text.length > 500000 || !Array.isArray(message.words)) {
              finish(new Error('OCR 返回内容无效'))
            } else finish(undefined, { text: message.text, words: message.words })
          } else if (message.type === 'error') finish(new Error(message.status ?? '本地 OCR 失败，请重试'))
        })
        worker.postMessage({ image: input.image, width: info.width, height: info.height, region: input.region,
          language: input.language, modelDir: this.options.modelDir, tempDir }, [input.image])
      })
      // Re-fetch after long recognition: a deleted book must not receive orphaned OCR data.
      validatePdfBook(this.options.database(), input.bookId)
      const record = { bookId: input.bookId, page: input.page,
        language: input.language, region: input.region, ...result }
      // A blank/positionless attempt must remain retryable rather than becoming a permanent layer.
      if (!result.text.trim() || !result.words.length) return { ...record, id: randomUUID(), createdAt: Date.now() }
      return savePdfOcr(this.options.database(), info.key, record)
    } finally {
      await termination
      if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {})
      if (this.active?.id === input.requestId && this.active.owner === owner) this.active = null
    }
  }
  async cancel(requestId: string, owner: number): Promise<void> {
    if (this.active?.id === requestId && this.active.owner === owner) await this.active.cancel()
  }
  async cancelOwner(owner: number): Promise<void> {
    if (this.active?.owner === owner) await this.active.cancel()
  }
  dispose(): void { void this.active?.cancel() }
}
