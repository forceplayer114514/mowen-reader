import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase, SCHEMA_VERSION } from '../../src/main/db'

describe('数据库版本标记', () => {
  let dir: string | null = null

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
      dir = null
    }
  })

  it('全新数据库打开后 user_version 就是当前 schema 版本号', () => {
    const db = openDatabase(':memory:')
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
    expect(row.user_version).toBe(SCHEMA_VERSION)
    db.close()
  })

  it('重新打开已有数据库文件,不会改动或重置已经盖上的版本号', () => {
    dir = mkdtempSync(join(tmpdir(), 'reader-db-version-'))
    const file = join(dir, 'library.db')

    const first = openDatabase(file)
    const firstVersion = (first.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version
    expect(firstVersion).toBe(SCHEMA_VERSION)
    first.close()

    const second = openDatabase(file)
    const secondVersion = (
      second.prepare('PRAGMA user_version').get() as { user_version: number }
    ).user_version
    expect(secondVersion).toBe(SCHEMA_VERSION)
    second.close()
  })
})
