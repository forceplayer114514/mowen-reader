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
})
