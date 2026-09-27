/**
 * 离线翻译 worker（跑在 node:worker_threads，与主进程/ UI 隔离）。
 *
 * 通信契约（给 root 打包用的稳定接口）：
 * - 父进程 `new Worker(workerPath)` 后 `postMessage({ type: 'translate',
 *   modelDir: string, text: string })`（可附带 `id: number`，回包原样带回）。
 * - 成功回 `{ ok: true, text: string, id? }`；失败回
 *   `{ ok: false, message: string, id? }`。worker 不抛未捕获异常、不打用户文本日志。
 * - 单次翻译单 worker 实例，用完父进程负责 terminate（无常驻状态，多并发各自独立）。
 *
 * 安全红线：`allowRemoteModels = false`，本地目录缺文件时直接报错，
 * 绝不在 translate 路径触发任何下载；不安装除 `@huggingface/transformers`
 *（root 安装）之外的任何模型运行时。
 */

import { parentPort } from 'node:worker_threads'
import { splitTranslationChunks } from './translation'

interface TranslateRequest {
  type: 'translate'
  modelDir: string
  text: string
  id?: number
}

interface TranslateReply {
  ok: boolean
  text?: string
  message?: string
  id?: number
}

let translator: Awaited<ReturnType<typeof loadTranslator>> | null = null
let translatorDir = ''

async function loadTranslator(modelDir: string): Promise<
  (text: string) => Promise<string>
> {
  const { env, pipeline } = await import('@huggingface/transformers')
  // 本地离线：禁止一切远程拉取，只读调用方传入的模型目录。
  env.allowRemoteModels = false
  env.allowLocalModels = true
  env.localModelPath = modelDir
  env.cacheDir = modelDir
  const pipe = await pipeline('translation', modelDir, {
    dtype: 'q8',
    device: 'cpu',
    session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 }
  })
  return async (text: string): Promise<string> => {
    const translated: string[] = []
    for (const chunk of splitTranslationChunks(text)) {
      if (!chunk.trim()) { translated.push(chunk); continue }
      const out = await pipe(chunk, { max_new_tokens: 512 })
      const first = Array.isArray(out) ? out[0] : out
      if (!first || typeof first.translation_text !== 'string' || !first.translation_text.trim()) {
        throw new Error('离线翻译返回无效')
      }
      translated.push(first.translation_text)
    }
    return translated.join('')
  }
}

function reply(message: TranslateReply): void {
  parentPort?.postMessage(message)
}

parentPort?.on('message', (request: TranslateRequest) => {
  void (async () => {
    try {
      if (!request || request.type !== 'translate') {
        throw new Error('未知的 worker 请求')
      }
      if (typeof request.modelDir !== 'string' || !request.modelDir) {
        throw new Error('离线模型目录无效')
      }
      if (typeof request.text !== 'string' || !request.text.trim()) {
        throw new Error('没有可翻译的内容')
      }
      if (request.text.length > 10000) throw new Error('一次最多翻译 10000 字，请分段翻译')
      if (!translator || translatorDir !== request.modelDir) {
        translator = await loadTranslator(request.modelDir)
        translatorDir = request.modelDir
      }
      const text = await translator(request.text)
      reply({ ok: true, text, id: request.id })
    } catch (error) {
      const message = error instanceof Error ? error.message : '离线翻译失败'
      // 缺依赖时给 root 可行动的提示（不透出用户文本）。
      if (/cannot find|failed to resolve|no such file|dlopen|wrong architecture|ERR_DLOPEN_FAILED/i.test(message)) {
        reply({ ok: false, message: '离线运行时缺失(@huggingface/transformers 未安装或模型文件不完整)', id: (request as TranslateRequest)?.id })
        return
      }
      reply({ ok: false, message, id: (request as TranslateRequest)?.id })
    }
  })()
})
