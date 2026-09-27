/**
 * 主进程与渲染层共用的翻译类型。
 *
 * v1 只支持英 → 简中（source 'en'，target 'zh-CN'），其他语言对直接报错。
 */

export type TranslationMode = 'online' | 'offline'

export type TranslationStatus = 'not-installed' | 'downloading' | 'installed' | 'error'

export interface TranslationSnapshot {
  status: TranslationStatus
  /** 已收到的字节数（下载中才有意义）。 */
  received: number
  /** 离线包总字节数（固定 manifest 求和）。 */
  total: number
  message: string | null
  /** 离线包总字节数（与 total 相同，语义为“完整包体大小”）。 */
  size: number
}

export interface TranslationResult {
  text: string
  engine: 'online' | 'offline'
}

export interface PackFileEntry {
  /** 相对模型目录的路径，只允许白名单里的值。 */
  name: string
  /** 期望字节数（来自 HF API x-linked-size / 实测 Content-Length）。 */
  size: number
  /**
   * HF resolve 头 `x-linked-etag` 的原始值（去引号）。
   * 40 位是小文件的 git blob sha1；64 位是 LFS/XET 大文件的内容 SHA256。
   * 下载后一律强校验（size + 对应哈希），缺一不可。
   */
  etag: string
}

export interface TranslationServiceDeps {
  /** 该用户专用的翻译目录（调用方按用户 profile 传入）。 */
  directory: string
  getSetting: (key: string) => string | null
  onChanged: (snapshot: TranslationSnapshot) => void
  /** 仅测试 / 特殊环境注入；缺省用全局 fetch。 */
  fetchImpl?: typeof fetch
  /**
   * 打包后的 worker 文件绝对路径（root 集成时按 Electron 打包产物传入）。
   * 不传则使用 `translation-worker.js` 与本模块同目录的默认推导。
   */
  workerPath?: string
  /**
   * 仅测试注入：覆盖离线包 manifest（默认用 Xenova/opus-mt-en-zh 量化包）。
   * 生产代码永远使用默认 manifest。
   */
  packFiles?: PackFileEntry[]
  /** 仅测试注入：覆盖在线接口基址（默认 MyMemory）。 */
  onlineBaseUrl?: string
  /** 仅测试注入：绕过真实 worker 的离线推理实现。 */
  translateOffline?: (text: string, opts: { modelDir: string; signal: AbortSignal }) => Promise<string>
  /** 仅测试缩短期限；生产单 chunk 最多等待 15s。 */
  timeoutMs?: number
}
