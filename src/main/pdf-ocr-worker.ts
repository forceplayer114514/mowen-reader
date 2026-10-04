import { parentPort } from 'node:worker_threads'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { createWorker } from 'tesseract.js'
import type { PdfOcrLanguage, PdfOcrRegion } from '../shared/pdf-ocr-types'
import { normalizeOcrWords } from './pdf-ocr'

interface Request { image: ArrayBuffer; width: number; height: number; language: PdfOcrLanguage;
  region: PdfOcrRegion | null; modelDir: string; tempDir: string }
function progress(status: string, value: number): void {
  parentPort?.postMessage({ type: 'progress', status, progress: value })
}
export async function ensurePdfOcrLanguage(language: 'eng' | 'chi_sim', request: Pick<Request, 'modelDir' | 'tempDir'>): Promise<void> {
  const file = join(request.modelDir, `${language}.traineddata`)
  try {
    const data = await readFile(file)
    const hash = (await readFile(`${file}.sha256`, 'utf8')).trim()
    if (data.length > 1024 && createHash('sha256').update(data).digest('hex') === hash) return
  } catch { /* Download is performed only after the user's explicit OCR request. */ }
  progress(`下载${language === 'eng' ? '英文' : '中文'}识别语言包`, 0)
  const response = await fetch(`https://cdn.jsdelivr.net/npm/@tesseract.js-data/${language}/4.0.0_best_int/${language}.traineddata.gz`,
    { signal: AbortSignal.timeout(120000), redirect: 'error' })
  if (!response.ok || !response.body) throw new Error('language download')
  const total = Number(response.headers.get('content-length'))
  let size = 0
  const chunks: Uint8Array[] = []
  const reader = response.body.getReader()
  while (true) {
    const { value: chunk, done } = await reader.read()
    if (done) break
    size += chunk.byteLength
    if (size > 64 * 1024 * 1024) throw new Error('language size')
    chunks.push(chunk)
    progress(`下载${language === 'eng' ? '英文' : '中文'}识别语言包`, total > 0 ? Math.min(0.99, size / total) : 0)
  }
  const model = gunzipSync(Buffer.concat(chunks), { maxOutputLength: 128 * 1024 * 1024 })
  if (model.length < 1024) throw new Error('language invalid')
  const temp = join(request.tempDir, `${language}.traineddata`)
  await writeFile(temp, model)
  await rename(temp, file)
  const hashTemp = `${temp}.sha256`
  await writeFile(hashTemp, createHash('sha256').update(model).digest('hex'))
  await rename(hashTemp, `${file}.sha256`)
  progress(`下载${language === 'eng' ? '英文' : '中文'}识别语言包`, 1)
}
parentPort?.once('message', (request: Request) => {
  void (async () => {
    let worker: Awaited<ReturnType<typeof createWorker>> | null = null
    let initialized = false
    try {
      for (const language of request.language.split('+') as Array<'eng' | 'chi_sim'>) await ensurePdfOcrLanguage(language, request)
      progress('启动本地识别引擎', 0)
      worker = await createWorker(request.language, 1, { langPath: request.modelDir, cacheMethod: 'none', gzip: false,
        logger: event => progress(event.status === 'recognizing text' ? '正在识别文字' : '启动本地识别引擎', event.progress) })
      initialized = true
      await worker.setParameters({ user_defined_dpi: '144' })
      const { data } = await worker.recognize(Buffer.from(request.image), {}, { text: true, blocks: true })
      const words = (data.blocks ?? []).flatMap(block => block.paragraphs.flatMap(paragraph => paragraph.lines.flatMap(line => line.words)))
      parentPort?.postMessage({ type: 'result', text: data.text.trim(),
        words: normalizeOcrWords(words, request.width, request.height, request.region) })
    } catch {
      parentPort?.postMessage({ type: 'error', status: initialized
        ? '本页识别失败，请尝试框选更清晰的文字区域'
        : 'OCR 语言包下载或引擎启动失败，请检查网络后重试' })
    } finally { await worker?.terminate() }
  })()
})
