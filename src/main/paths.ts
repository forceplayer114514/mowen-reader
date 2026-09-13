import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 应用数据目录的唯一来源。
 *
 * 本模块不导入 electron —— 因为项目是 ESM,`require('electron')` 在
 * 打包后的主进程里会直接抛错(ESM 没有 require)。真正的用户目录由
 * `src/main/index.ts` 在 `app.whenReady()` 里通过 `initDataDir()` 写入
 * `READER_USER_DATA` 环境变量,这里只读这个变量。
 * 测试与端到端也用同一个变量覆盖,避免污染真实用户目录。
 */
export function resolveDataDir(): string {
  const override = process.env.READER_USER_DATA
  if (!override) {
    throw new Error('应用数据目录未初始化')
  }
  mkdirSync(override, { recursive: true })
  return override
}

/** 设置应用数据目录。应在主进程启动时、其他逻辑运行前调用一次。 */
export function initDataDir(dir: string): void {
  process.env.READER_USER_DATA = dir
}

function sub(name: string): string {
  const dir = join(resolveDataDir(), name)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function booksDir(): string {
  return sub('books')
}

export function coversDir(): string {
  return sub('covers')
}

export function dbFile(): string {
  return join(resolveDataDir(), 'reader.db')
}
