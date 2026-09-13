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
   * 密钥被输入的那一刻,设置里那个接口地址的来源——协议 + 主机名 + 端口。
   * 更早的版本没有记这一项(v1 只加密裸密钥,v2 只记了主机名和端口、没记
   * 协议),这两种读出来都是 null。
   */
  origin: string | null
}

/**
 * 落盘格式的版本号。加密内容从"密钥字符串本身"换成了一个带版本号的 JSON
 * 信封,好把密钥和它对应的接口地址锁在同一份密文里。
 *
 * v2 记的是主机名 + 端口,不含协议,而端口只在它是当前协议的默认端口时才被
 * 省略——于是 `https://localhost:443` 和 `http://localhost:80` 会塌缩成同一
 * 个字符串 `localhost`,两个完全不同的服务被当成同一个收件人。v3 改记完整
 * 来源(含协议),v2 存下的一律按"没记地址"处理,要求重填一次。
 */
const ENVELOPE_VERSION = 3

/**
 * 写入 API 密钥,连同它当初是填给哪个接口地址一起。密钥用操作系统提供的
 * 加密能力加密后落盘,数据库文件被整个拷走也拿不到它。传空串等于清除。
 *
 * 地址和密钥一起进同一份密文,而不是另存一个文件或者写进设置表:设置表是
 * 渲染层能写的,分开存就等于允许"只改地址、不动密钥",而那正是要防的事。
 * 锁在一起之后,想换这个地址就必须重新输入一次密钥。
 */
export function setApiKey(key: string, origin: string | null = null): void {
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
  const envelope = JSON.stringify({ v: ENVELOPE_VERSION, origin, key })
  writeFileSync(keyFilePath(), storage.encryptString(envelope))
}

/**
 * 取回明文密钥和它绑定的接口地址。只在主进程内部调用——这两个值都不得
 * 经由任何 IPC 通道流向渲染进程。
 *
 * 认不出当前版本的信封时,把能认出来的密钥取出来、地址记为 null:更早的两种
 * 格式(裸密钥、只记主机名的 v2)都走这条路。升级上来的用户不会莫名其妙地
 * 丢掉已经存好的密钥,只是会被要求重新填一次(见 endpoint.ts 的
 * assertKeyBoundToEndpoint,以及 hasApiKey 对这种密钥的回答)。
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
    const parsed = JSON.parse(plain) as { v?: unknown; key?: unknown; origin?: unknown }
    if (typeof parsed.key === 'string') {
      const origin =
        parsed.v === ENVELOPE_VERSION && typeof parsed.origin === 'string' ? parsed.origin : null
      return { key: parsed.key, origin }
    }
  } catch {
    // 不是 JSON:v1 的裸密钥格式,下面原样当作密钥
  }
  return { key: plain, origin: null }
}

/** 只要密钥本身。调用方如果要把它发出去,必须先核对过 readApiKey() 里的 origin。 */
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
