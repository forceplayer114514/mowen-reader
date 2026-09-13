import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDataDir } from './paths'

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

/**
 * 本模块不导入 electron —— 跟 `src/main/paths.ts` 同样的理由:项目是 ESM,
 * `require('electron')` 在打包后的主进程里没有 require 可用,会直接抛错。
 * 真正的 safeStorage 由 `src/main/index.ts` 在 `app.whenReady()` 里通过
 * `initSecrets()` 注入,这里只持有一个模块内的私有槽位。
 */
let storage: SafeStorageLike | null = null

/** 应用启动时调用一次,注入真正的 Electron safeStorage。 */
export function initSecrets(safeStorage: SafeStorageLike): void {
  storage = safeStorage
}

/** 仅测试使用:注入一个假的 safeStorage,或传 null 复原到未初始化状态。 */
export function __setSafeStorageForTests(fake: SafeStorageLike | null): void {
  storage = fake
}

export function keyFilePath(): string {
  return join(resolveDataDir(), 'apikey.bin')
}

/**
 * 写入 API 密钥。密钥用操作系统提供的加密能力加密后落盘,数据库文件
 * 被整个拷走也拿不到它。传空串等于清除。
 */
export function setApiKey(key: string): void {
  if (key.length === 0) {
    clearApiKey()
    return
  }
  if (!storage) {
    throw new Error('安全存储尚未初始化')
  }
  if (!storage.isEncryptionAvailable()) {
    throw new Error('当前系统不支持安全加密存储,无法保存 API 密钥')
  }
  writeFileSync(keyFilePath(), storage.encryptString(key))
}

/** 取回明文密钥。只在主进程内部调用——这个值不得经由任何 IPC 通道流向渲染进程。 */
export function getApiKey(): string | null {
  if (!storage) return null
  const path = keyFilePath()
  if (!existsSync(path)) return null
  try {
    return storage.decryptString(readFileSync(path))
  } catch {
    // 文件损坏、或换了机器导致解不开:当作没设过,让用户重新填
    return null
  }
}

/** 只回答有没有设过,不返回内容——这是渲染层唯一被允许知道的事。 */
export function hasApiKey(): boolean {
  return getApiKey() !== null
}

export function clearApiKey(): void {
  rmSync(keyFilePath(), { force: true })
}
