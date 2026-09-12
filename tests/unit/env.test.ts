import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('运行环境', () => {
  it('Node 版本不低于 22.13,否则 node:sqlite 不可用', async () => {
    const [major, minor] = process.versions.node.split('.').map(Number)
    expect(major > 22 || (major === 22 && minor >= 13)).toBe(true)
  })

  it('node:sqlite 可直接导入并建表', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE t (a TEXT)')
    db.prepare('INSERT INTO t (a) VALUES (?)').run('hi')
    const row = db.prepare('SELECT a FROM t').get() as { a: string }
    expect(row.a).toBe('hi')
    db.close()
  })

  // 这个测试跑在系统 Node 下,不是 Electron 主进程,没法直接 import Electron
  // 来问它内置的 Node 版本。所以退而求其次:直接读 node_modules/electron 的
  // package.json 里声明的版本号。electron@33 内置 Node 20,没有 node:sqlite,
  // 应用一启动就会抛 ERR_UNKNOWN_BUILTIN_MODULE 崩溃;electron@44 起才自带
  // Node 24,才有 node:sqlite。如果以后有人把 electron 降回 44 以下,这个测试
  // 要能第一时间炸掉,而不是等到打包出来的 App 启动时才发现。
  it('Electron 版本不低于 44,否则其内置 Node 没有 node:sqlite', () => {
    const electronPkg = JSON.parse(
      readFileSync(new URL('../../node_modules/electron/package.json', import.meta.url), 'utf-8')
    ) as { version: string }
    const major = Number(electronPkg.version.split('.')[0])
    expect(major).toBeGreaterThanOrEqual(44)
  })
})
