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

export interface StoredApiKey {
  key: string
  /**
   * 密钥被输入的那一刻,设置里那个接口地址的主机名(含端口)。
   * 更早的版本只加密了密钥本身、没有记这一项,读出来是 null。
   */
  host: string | null
}

/**
 * 落盘格式的版本号。加密内容从"密钥字符串本身"换成了一个带版本号的 JSON
 * 信封,好把密钥和它对应的接口地址锁在同一份密文里。
 */
const ENVELOPE_VERSION = 2

/**
 * 写入 API 密钥,连同它当初是填给哪个接口地址一起。密钥用操作系统提供的
 * 加密能力加密后落盘,数据库文件被整个拷走也拿不到它。传空串等于清除。
 *
 * host 和密钥一起进同一份密文,而不是另存一个文件或者写进设置表:设置表是
 * 渲染层能写的,分开存就等于允许"只改地址、不动密钥",而那正是要防的事。
 * 锁在一起之后,想换这个地址就必须重新输入一次密钥。
 */
export function setApiKey(key: string, host: string | null = null): void {
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
  const envelope = JSON.stringify({ v: ENVELOPE_VERSION, host, key })
  writeFileSync(keyFilePath(), storage.encryptString(envelope))
}

/**
 * 取回明文密钥和它绑定的接口地址。只在主进程内部调用——这两个值都不得
 * 经由任何 IPC 通道流向渲染进程。
 *
 * 解不开新格式的信封时,把整段明文当作密钥本身、地址记为 null:那正是更早
 * 版本的落盘格式,升级上来的用户不会莫名其妙地丢掉已经存好的密钥,只是会在
 * 发起对话时被要求重新填一次(见 endpoint.ts 的 assertKeyBoundToEndpoint)。
 */
export function readApiKey(): StoredApiKey | null {
  if (!storage) return null
  const path = keyFilePath()
  if (!existsSync(path)) return null
  let plain: string
  try {
    plain = storage.decryptString(readFileSync(path))
  } catch {
    // 文件损坏、或换了机器导致解不开:当作没设过,让用户重新填
    return null
  }
  try {
    const parsed = JSON.parse(plain) as { v?: unknown; key?: unknown; host?: unknown }
    if (parsed.v === ENVELOPE_VERSION && typeof parsed.key === 'string') {
      return { key: parsed.key, host: typeof parsed.host === 'string' ? parsed.host : null }
    }
  } catch {
    // 不是 JSON:老格式,下面按裸密钥处理
  }
  return { key: plain, host: null }
}

/** 只要密钥本身。调用方如果要把它发出去,必须先核对过 readApiKey() 里的 host。 */
export function getApiKey(): string | null {
  return readApiKey()?.key ?? null
}

/** 只回答有没有设过,不返回内容——这是渲染层唯一被允许知道的事。 */
export function hasApiKey(): boolean {
  return readApiKey() !== null
}

export function clearApiKey(): void {
  rmSync(keyFilePath(), { force: true })
}
