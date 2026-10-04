import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../../src/main/db'
import { insertBook, deleteBook } from '../../src/main/db/books'
import { cachedPdfOcr, getPdfOcr, getPdfPosition, savePdfOcr, savePdfPosition } from '../../src/main/db/pdf-ocr'
import { normalizeOcrWords, normalizePdfPosition, PdfOcrService, validatePdfBook, validatePdfOcr } from '../../src/main/pdf-ocr'
import type { PdfOcrInput } from '../../src/shared/pdf-ocr-types'

function png(width = 600, height = 800): ArrayBuffer {
  const bytes = new Uint8Array(33)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); bytes.set([73, 72, 68, 82], 12)
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13); view.setUint32(16, width); view.setUint32(20, height)
  return bytes.buffer
}
function input(): PdfOcrInput {
  return { requestId: 'request-1', bookId: 'b', page: 3, language: 'eng', region: null, image: png() }
}
function book(db: ReturnType<typeof openDatabase>, id = 'b', extension = 'pdf'): void {
  insertBook(db, { id, title: '扫描书', filePath: `/b.${extension}`, author: null, coverPath: null,
    sourcePath: '', addedAt: 0, lastReadAt: null, lastReadCfi: null })
}
const words = [{ text: 'hello', x: 0.1, y: 0.2, width: 0.3, height: 0.1 }]
describe('按需 PDF OCR 安全边界', () => {
  it('限定 PNG、有效分辨率、语言和选区，不接受远程图片路径', () => {
    expect(validatePdfOcr(input())).toMatchObject({ width: 600, height: 800, key: 'full:eng' })
    for (const bad of [
      { image: 'https://example.com/a.png' }, { image: new ArrayBuffer(0) }, { image: png(0, 1) },
      { image: png(5000, 5000) }, { image: png(20000, 1) }, { page: 0 }, { page: 1.5 },
      { requestId: '../escape' }, { language: 'arbitrary' }, { region: { x: 0, y: 0, width: 2, height: 1 } },
      { region: { x: 0, y: 0, width: 0, height: 1 } }, { region: { x: NaN, y: 0, width: 1, height: 1 } }
    ]) expect(() => validatePdfOcr({ ...input(), ...bad } as PdfOcrInput)).toThrow()
    const corrupt = png(); new Uint8Array(corrupt)[0] = 0
    expect(() => validatePdfOcr({ ...input(), image: corrupt })).toThrow()
  })
  it('只对存在的 PDF 开放，不接受其他书籍', () => {
    const db = openDatabase(':memory:'); book(db); book(db, 'epub', 'epub')
    expect(() => validatePdfBook(db, 'b')).not.toThrow()
    expect(() => validatePdfBook(db, 'missing')).toThrow()
    expect(() => validatePdfBook(db, 'epub')).toThrow(); db.close()
  })
  it('区域识别坐标重新映射至完整页面，剔除无效边界', () => {
    const result = normalizeOcrWords([{ text: 'word', bbox: { x0: 10, y0: 20, x1: 50, y1: 40 } },
      { text: 'bad', bbox: { x0: 0, y0: 0, x1: -1, y1: 0 } }], 100, 100,
    { x: 0.1, y: 0.2, width: 0.5, height: 0.25 })
    expect(result).toHaveLength(1); expect(result[0].x).toBeCloseTo(0.15)
    expect(result[0].y).toBeCloseTo(0.25); expect(result[0].width).toBeCloseTo(0.2)
    expect(result[0].height).toBeCloseTo(0.05)
  })
  it('视口只保存有限坐标和物理页码', () => {
    expect(normalizePdfPosition({ page: 9, x: -2, y: 3 })).toEqual({ page: 9, x: 0, y: 1 })
    expect(() => normalizePdfPosition({ page: 0, x: 0, y: 0 })).toThrow()
    expect(() => normalizePdfPosition({ page: 1, x: 0, y: Infinity })).toThrow()
  })
})
describe('PDF OCR 结构化存储', () => {
  it('首次结果不会覆盖，区域隔离，删书级联清理', () => {
    const db = openDatabase(':memory:'); book(db)
    const source = { bookId: 'b', page: 3, language: 'eng' as const, region: null, text: 'original', words }
    const first = savePdfOcr(db, 'full:eng', source)
    expect(savePdfOcr(db, 'full:eng', { ...source, text: 'replacement' })).toEqual(first)
    const other = savePdfOcr(db, 'region-hash', { ...source, region: { x: 0, y: 0, width: 0.5, height: 0.5 } })
    expect(getPdfOcr(db, 'b', 3)).toEqual([first, other]); expect(getPdfOcr(db, 'b', 2)).toEqual([])
    expect(cachedPdfOcr(db, 'b', 3, 'unknown')).toBeNull()
    savePdfPosition(db, 'b', { page: 3, x: 0.3, y: 0.6 })
    expect(getPdfPosition(db, 'b')).toEqual({ page: 3, x: 0.3, y: 0.6 })
    deleteBook(db, 'b')
    expect(getPdfOcr(db, 'b', 3)).toEqual([]); expect(getPdfPosition(db, 'b')).toBeNull(); db.close()
  })
  it('重开数据库保留 OCR 文本、稳定 id 和阅读视口', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mowen-ocr-db-'))
    try {
      const file = join(dir, 'reader.db')
      let db = openDatabase(file); book(db)
      const result = savePdfOcr(db, 'full:eng', { bookId: 'b', page: 3, language: 'eng', region: null, text: 'stored', words })
      savePdfPosition(db, 'b', { page: 3, x: 0.8, y: 0.7 }); db.close(); db = openDatabase(file)
      expect(getPdfOcr(db, 'b', 3)).toEqual([result]); expect(getPdfPosition(db, 'b')).toEqual({ page: 3, x: 0.8, y: 0.7 }); db.close()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
describe('PDF OCR worker 生命周期', () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
  function setup(timeout?: number): { service: PdfOcrService; worker: EventEmitter & { postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> }; db: ReturnType<typeof openDatabase> } {
    const dir = mkdtempSync(join(tmpdir(), 'mowen-ocr-worker-')); dirs.push(dir)
    const db = openDatabase(':memory:'); book(db)
    const worker = Object.assign(new EventEmitter(), { postMessage: vi.fn(), terminate: vi.fn(async () => 0) })
    const service = new PdfOcrService({ database: () => db, workerPath: 'unused', modelDir: dir, timeout,
      workerFactory: () => worker as unknown as Worker })
    return { service, worker, db }
  }
  it('按请求转发进度，成功后缓存，不重复启动引擎', async () => {
    const { service, worker, db } = setup(); const progress = vi.fn()
    const result = service.recognize(input(), 1, progress)
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalled())
    worker.emit('message', { type: 'progress', status: '识别中', progress: 0.5 })
    worker.emit('message', { type: 'result', text: 'hello', words })
    const saved = await result
    expect(progress).toHaveBeenCalledWith({ requestId: 'request-1', status: '识别中', progress: 0.5 })
    expect(saved.text).toBe('hello'); expect(worker.terminate).toHaveBeenCalled()
    expect(await service.recognize(input(), 1, progress)).toEqual(saved)
    expect(worker.postMessage).toHaveBeenCalledTimes(1); db.close()
  })
  it('空白或无定位结果不固化为缓存，允许重新识别', async () => {
    const { service, worker, db } = setup()
    const result = service.recognize(input(), 1, () => {})
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalled())
    worker.emit('message', { type: 'result', text: '', words: [] })
    expect((await result).text).toBe(''); expect(getPdfOcr(db, 'b', 3)).toEqual([]); db.close()
  })
  it('只有所属窗口可取消，取消不留数据，并允许重试', async () => {
    const { service, worker, db } = setup()
    const outcome = service.recognize(input(), 1, () => {}).catch(error => error.message)
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalled())
    await service.cancel('request-1', 2); expect(worker.terminate).not.toHaveBeenCalled()
    await service.cancel('request-1', 1)
    expect(await outcome).toBe('已取消识别'); expect(getPdfOcr(db, 'b', 3)).toEqual([])
    const again = service.recognize(input(), 1, () => {}).catch(error => error.message)
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(2))
    await service.cancelOwner(1); expect(await again).toBe('已取消识别'); db.close()
  })
  it('并发不会创建多个引擎，超时终止且不保存结果', async () => {
    const { service, worker, db } = setup(150)
    const outcome = service.recognize(input(), 1, () => {}).catch(error => error.message)
    await expect(service.recognize({ ...input(), requestId: 'second' }, 1, () => {})).rejects.toThrow('已有书页')
    expect(await outcome).toContain('OCR 超时')
    expect(worker.terminate).toHaveBeenCalled(); expect(getPdfOcr(db, 'b', 3)).toEqual([]); db.close()
  })
})
