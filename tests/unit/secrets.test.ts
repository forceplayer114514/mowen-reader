import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  __setSafeStorageForTests,
  clearApiKey,
  getApiKey,
  hasApiKey,
  keyFilePath,
  readApiKey,
  setApiKey
} from '../../src/main/secrets'

/** 假的 safeStorage:用可逆的字节反转冒充加密,足以验证"落盘的不是明文"。 */
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(Buffer.from(s, 'utf8').reverse()),
  decryptString: (b: Buffer) => Buffer.from(Buffer.from(b).reverse()).toString('utf8')
}

beforeEach(() => {
  process.env.READER_USER_DATA = mkdtempSync(join(tmpdir(), 'reader-secrets-'))
  __setSafeStorageForTests(fakeSafeStorage)
})

describe('API 密钥存取', () => {
  it('没设过时读出来是 null,hasApiKey 为 false', () => {
    expect(getApiKey()).toBeNull()
    expect(hasApiKey()).toBe(false)
  })

  it('写入后能原样读回', () => {
    setApiKey('sk-测试-1234')
    expect(getApiKey()).toBe('sk-测试-1234')
    expect(hasApiKey()).toBe(true)
  })

  it('落盘的内容不是明文', () => {
    setApiKey('sk-明文不该出现')
    const raw = readFileSync(keyFilePath())
    expect(raw.toString('utf8')).not.toContain('sk-明文不该出现')
  })

  it('重复写入是覆盖', () => {
    setApiKey('旧的')
    setApiKey('新的')
    expect(getApiKey()).toBe('新的')
  })

  it('清除后文件消失,读出来是 null', () => {
    setApiKey('sk-x')
    clearApiKey()
    expect(existsSync(keyFilePath())).toBe(false)
    expect(getApiKey()).toBeNull()
    expect(hasApiKey()).toBe(false)
  })

  it('写入空串等于清除', () => {
    setApiKey('sk-x')
    setApiKey('')
    expect(getApiKey()).toBeNull()
  })

  it('文件损坏时返回 null 而不是抛错', () => {
    setApiKey('sk-x')
    writeFileSync(keyFilePath(), Buffer.from([0, 1, 2]))
    __setSafeStorageForTests({
      ...fakeSafeStorage,
      decryptString: () => {
        throw new Error('解密失败')
      }
    })
    expect(getApiKey()).toBeNull()
  })

  it('系统不支持加密时写入抛出可读的中文错误', () => {
    __setSafeStorageForTests({ ...fakeSafeStorage, isEncryptionAvailable: () => false })
    expect(() => setApiKey('sk-x')).toThrow(/加密/)
  })
})

describe('safeStorage 未初始化', () => {
  beforeEach(() => {
    __setSafeStorageForTests(null)
  })

  it('getApiKey 返回 null,hasApiKey 返回 false,setApiKey 抛出中文错误', () => {
    expect(getApiKey()).toBeNull()
    expect(hasApiKey()).toBe(false)
    expect(() => setApiKey('x')).toThrow('安全存储尚未初始化')
  })
})

describe('密钥与填写它时的接口地址一起存', () => {
  it('存的时候记下地址,读回来能拿到', () => {
    setApiKey('sk-x', 'api.openai.com')
    expect(readApiKey()).toEqual({ key: 'sk-x', host: 'api.openai.com' })
  })

  it('落盘的内容里地址也不是明文', () => {
    setApiKey('sk-x', 'api.openai.com')
    expect(readFileSync(keyFilePath()).toString('utf8')).not.toContain('api.openai.com')
  })

  it('重写密钥会一并换掉记下的地址', () => {
    setApiKey('sk-x', 'api.openai.com')
    setApiKey('sk-y', '127.0.0.1:1234')
    expect(readApiKey()).toEqual({ key: 'sk-y', host: '127.0.0.1:1234' })
  })

  it('没设过时读出来是 null', () => {
    expect(readApiKey()).toBeNull()
  })

  it('旧版本直接加密裸密钥存下的文件,读出来密钥照旧、地址是 null', () => {
    // 旧格式就是"把密钥字符串本身加密后落盘",这里原样重建那个文件
    writeFileSync(keyFilePath(), fakeSafeStorage.encryptString('sk-老版本存的'))
    expect(readApiKey()).toEqual({ key: 'sk-老版本存的', host: null })
    expect(getApiKey()).toBe('sk-老版本存的')
  })
})
