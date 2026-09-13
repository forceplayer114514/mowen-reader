import { describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/main/db'
import {
  ALLOWED_SETTING_KEYS,
  assertAllowedSettingKey,
  getSetting,
  getSettingNumber,
  setSetting
} from '../../src/main/db/settings'

describe('设置表', () => {
  it('没写过的键读出来是 null', () => {
    const db = openDatabase(':memory:')
    expect(getSetting(db, 'fontSize')).toBeNull()
    db.close()
  })

  it('写入后能读回', () => {
    const db = openDatabase(':memory:')
    setSetting(db, 'theme', 'dark')
    expect(getSetting(db, 'theme')).toBe('dark')
    db.close()
  })

  it('同一个键重复写是覆盖不是报错', () => {
    const db = openDatabase(':memory:')
    setSetting(db, 'theme', 'dark')
    setSetting(db, 'theme', 'light')
    expect(getSetting(db, 'theme')).toBe('light')
    db.close()
  })

  it('数字读取:没写过给默认值,写过的转成数字', () => {
    const db = openDatabase(':memory:')
    expect(getSettingNumber(db, 'fontSize', 18)).toBe(18)
    setSetting(db, 'fontSize', '22')
    expect(getSettingNumber(db, 'fontSize', 18)).toBe(22)
    db.close()
  })

  it('存的不是数字时退回默认值,不返回 NaN', () => {
    const db = openDatabase(':memory:')
    setSetting(db, 'fontSize', '大号')
    expect(getSettingNumber(db, 'fontSize', 18)).toBe(18)
    db.close()
  })
})

describe('设置键白名单', () => {
  it('计划一和计划二用到的键都在名单里', () => {
    for (const key of [
      'fontSize',
      'theme',
      'llmEndpoint',
      'llmModel',
      'llmSystemPrompt',
      'llmContextLimit',
      'sidebarWidth'
    ]) {
      expect(() => assertAllowedSettingKey(key)).not.toThrow()
    }
  })

  it('名单外的键被拒绝,错误信息里带上这个键名', () => {
    expect(() => assertAllowedSettingKey('随便什么键')).toThrow(/随便什么键/)
  })

  it('名单内两两不重复', () => {
    expect(new Set(ALLOWED_SETTING_KEYS).size).toBe(ALLOWED_SETTING_KEYS.length)
  })
})
