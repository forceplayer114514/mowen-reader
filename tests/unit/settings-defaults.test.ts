import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONTEXT_LIMIT,
  DEFAULT_SYSTEM_PROMPT,
  SETTING_KEYS
} from '../../src/renderer/settings/defaults'

describe('设置默认值', () => {
  it('默认上下文上限是 8000', () => {
    expect(DEFAULT_CONTEXT_LIMIT).toBe(8000)
  })

  it('默认提示词要求中文回答且不剧透后文', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('中文')
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/剧透|后文/)
  })

  it('设置键名不冲突且两两不重复', () => {
    const existing = ['fontSize', 'theme']
    const values = Object.values(SETTING_KEYS)
    for (const key of values) expect(existing).not.toContain(key)
    expect(new Set(values).size).toBe(values.length)
  })
})
