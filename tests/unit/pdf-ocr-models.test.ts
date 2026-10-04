import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensurePdfOcrLanguage } from '../../src/main/pdf-ocr-worker'

describe('本地 OCR 模型按需下载', () => {
  const dirs: string[] = []
  afterEach(() => {
    vi.restoreAllMocks()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  async function setup(): Promise<{ modelDir: string; tempDir: string }> {
    const modelDir = mkdtempSync(join(tmpdir(), 'mowen-ocr-model-test-')); dirs.push(modelDir)
    const tempDir = join(modelDir, '.download-test'); await mkdir(tempDir)
    return { modelDir, tempDir }
  }
  it('只取固定模型 URL，原子写入并复用经过完整性验证的本地模型', async () => {
    const request = await setup(), model = Buffer.alloc(2048, 7)
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(gzipSync(model)))
    await ensurePdfOcrLanguage('eng', request)
    expect(fetch).toHaveBeenCalledWith('https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz',
      expect.objectContaining({ redirect: 'error' }))
    expect(await readFile(join(request.modelDir, 'eng.traineddata'))).toEqual(model)
    expect((await readFile(join(request.modelDir, 'eng.traineddata.sha256'), 'utf8')).length).toBe(64)
    await ensurePdfOcrLanguage('eng', request)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(await readdir(request.tempDir)).toEqual([])
  })
  it('缓存被截断或校验不符时重新下载，而不是永久锁定失败', async () => {
    const request = await setup(), model = Buffer.alloc(2048, 7)
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(gzipSync(model)))
    await ensurePdfOcrLanguage('chi_sim', request)
    await writeFile(join(request.modelDir, 'chi_sim.traineddata'), Buffer.alloc(2048, 9))
    await ensurePdfOcrLanguage('chi_sim', request)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(await readFile(join(request.modelDir, 'chi_sim.traineddata'))).toEqual(model)
  })
  it('网络失败或非法压缩包不会留下正式模型和完整性标记', async () => {
    const request = await setup()
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('failure', { status: 503 }))
    await expect(ensurePdfOcrLanguage('eng', request)).rejects.toThrow()
    fetch.mockResolvedValue(new Response('invalid gzip'))
    await expect(ensurePdfOcrLanguage('eng', request)).rejects.toThrow()
    expect(await readdir(request.modelDir)).toEqual(['.download-test'])
    expect(await readdir(request.tempDir)).toEqual([])
  })
})
