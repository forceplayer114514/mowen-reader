import { expect, test } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { closeAllApps, importFixture, launch, waitForLocationsReady, type Harness } from './helpers'

test.afterEach(closeAllApps)

async function seedStats(h: Harness): Promise<void> {
  const [book] = await h.page.evaluate(() => window.api.listBooks())
  const db = new DatabaseSync(join(h.userData, 'reader.db'))
  try {
    const insert = db.prepare('INSERT INTO reading_time (book_id, day, milliseconds) VALUES (?, ?, ?)')
    for (let i = 0; i < 7; i++) {
      const now = new Date()
      const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
      const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
      insert.run(book.id, day, (i + 1) * 60_000)
    }
  } finally { db.close() }
}

test('空统计、失败重试、7/30天图表、单书排行、两种主题及重启保留', async () => {
  let h = await launch()
  await h.page.getByTestId('open-stats').click()
  await expect(h.page.getByTestId('stats-today')).toHaveText('0 分钟')
  await expect(h.page.getByTestId('stats-chart').getByRole('button')).toHaveCount(7)
  await expect(h.page.getByText('还没有书籍。回到书架，添加你的第一本书吧。')).toBeVisible()
  await h.page.getByRole('button', { name: '← 返回书架' }).click()
  await importFixture(h)
  await seedStats(h)
  // 只在隔离测试进程里模拟一次 IPC 故障，验证错误不会显示成空统计。
  await h.app.evaluate(({ ipcMain }) => {
    const handler = (ipcMain as any)._invokeHandlers.get('reading:stats')
    ipcMain.removeHandler('reading:stats')
    let fail = true
    ipcMain.handle('reading:stats', (...args: unknown[]) => {
      if (fail) { fail = false; throw new Error('test disk unavailable') }
      return handler(...args)
    })
  })
  await h.page.getByTestId('open-stats').click()
  await expect(h.page.getByRole('alert')).toContainText('统计暂时无法读取')
  await h.page.getByRole('button', { name: '重试', exact: true }).click()
  await expect(h.page.getByRole('alert')).toHaveCount(0)
  await expect(h.page.getByTestId('stats-today')).toHaveText('1 分钟')
  await h.page.getByTestId('reading-goal').selectOption('10')
  await expect(h.page.getByTestId('reading-goal-progress')).toHaveText('已完成 10%')
  await expect(h.page.getByRole('progressbar', { name: '今日阅读目标' })).toHaveAttribute('aria-valuenow', '10')
  await expect(h.page.getByTestId('stats-week')).toHaveText('28 分钟')
  await expect(h.page.getByTestId('stats-total')).toHaveText('28 分钟')
  await expect(h.page.getByTestId('stats-book')).toContainText('测试之书')
  await expect(h.page.getByTestId('stats-book')).toContainText('28 分钟')
  await h.page.screenshot({ path: '/tmp/mowen-reading-stats-light.png', fullPage: true })
  await h.page.getByRole('button', { name: '近 30 天', exact: true }).click()
  await expect(h.page.getByTestId('stats-chart').getByRole('button')).toHaveCount(30)
  await expect(h.page.getByTestId('stats-week')).toHaveText('28 分钟')
  await h.page.getByTestId('stats-chart').getByRole('button').first().focus()
  await expect(h.page.locator('.reading-stats__chart-detail')).toContainText('0 分钟')
  await h.page.getByTestId('toggle-theme').click()
  await expect(h.page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await h.page.waitForTimeout(180) // 等主题的 140ms 按钮颜色过渡结束再截图。
  await h.page.screenshot({ path: '/tmp/mowen-reading-stats-dark.png', fullPage: true })
  // 最小窗口尺寸下无横向溢出；整个测试不显示/聚焦原生窗口。
  await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 600))
  expect(await h.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await h.page.getByTestId('stats-book').click()
  await waitForLocationsReady(h)
  await h.page.getByRole('button', { name: '← 书架', exact: true }).click()
  await h.app.close()
  h = await launch(h.userData)
  await h.page.getByTestId('open-stats').click()
  await expect(h.page.getByTestId('stats-total')).toHaveText('28 分钟')
  await expect(h.page.getByTestId('stats-book')).toHaveCount(1)
  await expect(h.page.getByTestId('reading-goal')).toHaveValue('10')
})

test('隐藏测试窗口的阅读与重载均不计时，非法书籍拒绝', async () => {
  const h = await launch()
  await importFixture(h)
  await h.page.getByTestId('book-card').first().click()
  await waitForLocationsReady(h)
  await h.page.waitForTimeout(2200)
  expect(await h.page.evaluate(() => window.api.readingStats())).toEqual({ days: [], books: [] })
  await h.page.reload()
  await h.page.getByTestId('library').waitFor()
  await h.page.waitForTimeout(1100)
  expect(await h.page.evaluate(() => window.api.readingStats())).toEqual({ days: [], books: [] })
  expect(await h.page.evaluate(async () => {
    try { await window.api.setReadingBook('missing'); return false } catch { return true }
  })).toBe(true)
})

test('真实 IPC 计时在正文就绪后启动，主题/字号不重置；失焦与返回书架立即补存暂停', async () => {
  const h = await launch()
  await importFixture(h)
  // 在隔离进程中模拟前台条件，不显示窗口，不抢用户焦点。
  await h.app.evaluate(({ BrowserWindow, powerMonitor, ipcMain }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win.isFocused = () => true
    win.isVisible = () => true
    powerMonitor.getSystemIdleTime = () => 0
    const handler = (ipcMain as any)._invokeHandlers.get('reading:book')
    ;(globalThis as any).__statsBook = null
    ipcMain.removeHandler('reading:book')
    ipcMain.handle('reading:book', (event, bookId) => {
      ;(globalThis as any).__statsBook = bookId
      return handler(event, bookId)
    })
  })
  await h.page.getByTestId('book-card').first().click()
  await waitForLocationsReady(h)
  const [book] = await h.page.evaluate(() => window.api.listBooks())
  await expect.poll(() => h.app.evaluate(() => (globalThis as any).__statsBook)).toBe(book.id)
  await h.page.waitForTimeout(2200)
  const first = await h.page.evaluate(() => window.api.readingStats())
  expect(first.books[0].milliseconds).toBeGreaterThanOrEqual(1000)
  await h.page.getByTestId('toggle-theme').click()
  await h.app.evaluate(({ ipcMain }) => {
    const handler = (ipcMain as any)._invokeHandlers.get('settings:set')
    ipcMain.removeHandler('settings:set')
    ipcMain.handle('settings:set', (event, key, value) => {
      if (key === 'fontSize') throw new Error('test settings disk failure')
      return handler(event, key, value)
    })
  })
  await h.page.getByRole('button', { name: '放大字号', exact: true }).click()
  await expect(h.page.getByText('字号没有保存,下次打开可能会恢复默认', { exact: true })).toBeVisible()
  await h.page.waitForTimeout(1100)
  const after = await h.page.evaluate(() => window.api.readingStats())
  expect(after.books[0].milliseconds).toBeGreaterThan(first.books[0].milliseconds + 500)
  await h.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win.isFocused = () => false
    win.emit('blur')
  })
  const paused = await h.page.evaluate(() => window.api.readingStats())
  await h.page.waitForTimeout(1100)
  expect(await h.page.evaluate(() => window.api.readingStats())).toEqual(paused)
  await h.page.getByRole('button', { name: '← 书架', exact: true }).click()
  await expect.poll(() => h.app.evaluate(() => (globalThis as any).__statsBook)).toBeNull()
  await h.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win.isFocused = () => true
    win.emit('focus')
  })
  await h.page.waitForTimeout(1100)
  expect(await h.page.evaluate(() => window.api.readingStats())).toEqual(paused)
})
