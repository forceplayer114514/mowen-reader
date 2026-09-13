import type { Db } from './index'

/**
 * 渲染层允许写入的设置键,穷举。
 *
 * 计划一的 fontSize / theme,加计划二的五个键(和计划里的 SETTING_KEYS
 * 一一对应)。这是纵深防御:真正堵住"密钥被引导着发给攻击者"那条路的是
 * llm/endpoint.ts 里的地址绑定校验,因为 llmEndpoint 本来就是合法键、
 * 白名单拦不住它;但一条从渲染层通往主进程设置表、键名不受限的写入通道
 * 本身就是个问题——设置表的键将来会被主进程自己拿来做判断,不该允许
 * 渲染层往里塞任意条目。
 */
export const ALLOWED_SETTING_KEYS = [
  'fontSize',
  'theme',
  'llmEndpoint',
  'llmModel',
  'llmSystemPrompt',
  'llmContextLimit',
  'sidebarWidth'
] as const

/** 键不在白名单里就抛出;错误信息带上键名,便于排查是哪一处写错了。 */
export function assertAllowedSettingKey(key: string): void {
  if (!(ALLOWED_SETTING_KEYS as readonly string[]).includes(key)) {
    throw new Error(`不认识的设置项:${key}`)
  }
}

export function getSetting(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row ? row.value : null
}

export function setSetting(db: Db, key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value)
}

export function getSettingNumber(db: Db, key: string, fallback: number): number {
  const raw = getSetting(db, key)
  if (raw === null) return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}
