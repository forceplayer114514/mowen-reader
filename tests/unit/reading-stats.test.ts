import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/main/db'
import { deleteBook, insertBook } from '../../src/main/db/books'
import { getReadingStats, saveReadingTime } from '../../src/main/db/reading-stats'
import { createReadingTimer } from '../../src/main/reading-timer'
import { formatReadingTime, localDay, readingPercent } from '../../src/shared/reading-stats'

function book(db: ReturnType<typeof openDatabase>, id = 'a'): void {
  insertBook(db, { id, title: id, author: null, coverPath: null, filePath: '/a.epub',
    sourcePath: '', addedAt: 0, lastReadAt: null, lastReadCfi: null })
}

describe('阅读计时与结构化存储', () => {
  it('百分比不提前四舍五入为读完，并防御无效数值', () => {
    expect([undefined, 0, 1 / 3, 0.9999, 1, NaN, Infinity].map(value => readingPercent(value))).toEqual([0, 0, 33, 99, 100, 0, 0])
  })
  it('仅计活跃区间；切书、失焦、重复刷新不会重复计时；长阻塞不计入', () => {
    const db = openDatabase(':memory:')
    book(db); book(db, 'b')
    let clock = 0
    const wall = new Date(2026, 8, 28, 12).getTime()
    const timer = createReadingTimer((id, entries) => saveReadingTime(db, id, entries), () => wall + clock, () => clock)
    timer.setBook('a')
    clock += 3000; timer.tick() // 隐藏窗口
    timer.setActive(true)
    clock += 3000; timer.tick()
    timer.setActive(false)
    clock += 4000; timer.tick()
    timer.setActive(true)
    clock += 2000; timer.setBook('b')
    clock += 1000; timer.tick()
    clock += 100_000; timer.tick() // 休眠/事件循环长暂停
    clock += 1000; timer.flush(); timer.flush()
    timer.setBook(null)
    clock += 1000; timer.flush()
    expect(getReadingStats(db)).toEqual({
      days: [{ day: localDay(new Date(wall)), milliseconds: 7000 }],
      books: [{ bookId: 'a', milliseconds: 5000, days: 1, lastDay: '2026-09-28' },
        { bookId: 'b', milliseconds: 2000, days: 1, lastDay: '2026-09-28' }]
    })
    db.close()
  })

  it('跨本地午夜分开记录，系统时钟调整不增加计时', () => {
    const db = openDatabase(':memory:'); book(db)
    let wall = new Date(2026, 8, 28, 23, 59, 59).getTime()
    let mono = 0
    const timer = createReadingTimer((id, entries) => saveReadingTime(db, id, entries), () => wall, () => mono)
    timer.setBook('a'); timer.setActive(true)
    mono += 2000; wall += 2000; timer.flush()
    expect(getReadingStats(db).days).toEqual([
      { day: '2026-09-28', milliseconds: 1000 }, { day: '2026-09-29', milliseconds: 1000 }
    ])
    mono += 1000; wall -= 3_600_000; timer.flush()
    expect(getReadingStats(db).books[0].milliseconds).toBe(3000)
    db.close()
  })

  it('保存失败保留缓冲，重试不重复；不同书籍部分成功也不重复', () => {
    const db = openDatabase(':memory:'); book(db); book(db, 'b')
    let fail: 'all' | 'b' | false = 'all'
    let clock = 0
    const timer = createReadingTimer((id, entries) => {
      if (fail === 'all' || (fail === 'b' && id === 'b')) throw new Error('disk full')
      saveReadingTime(db, id, entries)
    }, () => new Date(2026, 8, 28).getTime() + clock, () => clock)
    timer.setBook('a'); timer.setActive(true)
    clock += 1000
    expect(() => timer.setBook('b')).toThrow('disk full')
    clock += 2000; timer.tick()
    fail = 'b'
    expect(() => timer.flush()).toThrow('disk full')
    expect(getReadingStats(db).books.map(row => [row.bookId, row.milliseconds])).toEqual([['a', 1000]])
    fail = false
    timer.flush(); timer.flush()
    expect(getReadingStats(db).books.map(row => [row.bookId, row.milliseconds])).toEqual([['b', 2000], ['a', 1000]])
    db.close()
  })

  it('事务中途失败完全回滚；删除书籍后迟到的保存不会生成孤儿记录', () => {
    const db = openDatabase(':memory:'); book(db)
    expect(() => saveReadingTime(db, 'a', new Map([['2026-09-28', 1000], ['2026-09-29', Infinity]]))).toThrow()
    expect(getReadingStats(db).days).toEqual([])
    saveReadingTime(db, 'a', new Map([['2026-09-28', 1000]]))
    deleteBook(db, 'a')
    saveReadingTime(db, 'a', new Map([['2026-09-28', 1000]]))
    expect(getReadingStats(db)).toEqual({ days: [], books: [] })
    db.close()
  })

  it('旧版本升级、退出重开保留统计和原书库，按书/日期累加', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mowen-stats-'))
    try {
      const file = join(dir, 'library.db')
      let db = openDatabase(file); book(db)
      db.exec('DROP TABLE reading_time; PRAGMA user_version = 5'); db.close()
      db = openDatabase(file)
      saveReadingTime(db, 'a', new Map([['2026-09-27', 30000], ['2026-09-28', 60000]]))
      db.close(); db = openDatabase(file)
      saveReadingTime(db, 'a', new Map([['2026-09-28', 60000]]))
      expect(getReadingStats(db)).toEqual({ days: [{ day: '2026-09-27', milliseconds: 30000 },
        { day: '2026-09-28', milliseconds: 120000 }], books: [{ bookId: 'a', milliseconds: 150000, days: 2, lastDay: '2026-09-28' }] })
      expect(db.prepare('PRAGMA integrity_check').get()).toMatchObject({ integrity_check: 'ok' })
      db.close()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('阅读时长显示不把几秒误报成一分钟', () => {
    expect(formatReadingTime(0)).toBe('0 分钟')
    expect(formatReadingTime(59999)).toBe('不到 1 分钟')
    expect(formatReadingTime(60_000)).toBe('1 分钟')
    expect(formatReadingTime(3_660_000)).toBe('1 小时 1 分钟')
  })
})
