import { expect, test } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { closeAllApps, importFixture, importRealisticFixture, launch,
  waitForLocationsReady, waitForStableIndicator } from './helpers'
import { compareCfi } from '../../src/renderer/reader/cfi'

test.afterEach(closeAllApps)

test('书架按书名/作者实时搜索，大小写和空白兼容；清空、无匹配、主题及空书库', async () => {
  const h = await launch()
  await expect(h.page.getByTestId('continue-reading')).toBeDisabled()
  await importFixture(h)
  await importRealisticFixture(h)
  await expect(h.page.getByTestId('book-card')).toHaveCount(2)
  const books = await h.page.evaluate(() => window.api.listBooks())
  const search = h.page.getByTestId('library-search')
  await search.fill('  测试之书  ')
  await expect(h.page.getByTestId('book-card')).toHaveCount(1)
  await expect(h.page.locator('.book-card__title')).toHaveText('测试之书')
  await expect(h.page.getByTestId('library-count')).toHaveText('1 / 2 本书')
  await search.fill(books.find(book => book.title !== '测试之书')!.author!)
  await expect(h.page.getByTestId('book-card')).toHaveCount(1)
  const db = new DatabaseSync(join(h.userData, 'reader.db'))
  try {
    db.prepare('UPDATE books SET title = ?, author = ? WHERE id = ?')
      .run('The Correspondent', 'Virginia Evans', books.find(book => book.title !== '测试之书')!.id)
  } finally { db.close() }
  await h.page.reload()
  await search.fill('  the CORRESPONDENT  ')
  await expect(h.page.locator('.book-card__title')).toHaveText('The Correspondent')
  await search.fill('Ｔｈｅ Ｃｏｒｒｅｓｐｏｎｄｅｎｔ')
  await expect(h.page.getByTestId('book-card')).toHaveCount(1)
  await search.fill('vIRGINIA')
  await expect(h.page.getByTestId('book-card')).toHaveCount(1)
  await search.fill('不存在的书 [abc]%')
  await expect(h.page.getByTestId('book-card')).toHaveCount(0)
  await expect(h.page.getByText('没有找到匹配的图书', { exact: true })).toBeVisible()
  await h.page.getByRole('button', { name: '查看全部书籍', exact: true }).click()
  await expect(search).toHaveValue('')
  await expect(h.page.getByTestId('book-card')).toHaveCount(2)
  await search.fill('测试')
  await h.page.getByRole('button', { name: '清空搜索', exact: true }).click()
  await expect(search).toHaveValue('')
  await search.fill('none')
  await search.press('Escape')
  await expect(search).toHaveValue('')
  await h.page.getByTestId('toggle-theme').click()
  await expect(h.page.getByTestId('library-search')).toBeVisible()
  expect(await h.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('继续阅读始终打开最近读的书，保留位置，不受搜索影响；只重开不翻页与重启均更新', async () => {
  let h = await launch()
  await importFixture(h)
  await importRealisticFixture(h)
  await expect(h.page.getByTestId('book-card')).toHaveCount(2)
  const books = await h.page.evaluate(() => window.api.listBooks())
  const first = books.find(book => book.title === '测试之书')!
  const second = books.find(book => book.id !== first.id)!
  // 只读第一本；第二本尚未读过，不应误选最新导入的书。
  await h.page.getByRole('button', { name: `打开《${first.title}》`, exact: true }).click()
  await waitForLocationsReady(h)
  await h.page.getByRole('button', { name: '← 书架', exact: true }).click()
  await expect(h.page.getByTestId('continue-reading')).toHaveText('↗继续阅读（测试之书）')
  await h.page.getByTestId('library-search').fill(second.title)
  await expect(h.page.getByTestId('book-card')).toHaveCount(1)
  await h.page.getByTestId('continue-reading').click()
  await waitForLocationsReady(h)
  await expect(h.page.locator('.reader__title')).toHaveText(first.title)
  await h.page.getByTestId('toggle-toc').click()
  await h.page.getByRole('button', { name: '第二章 那个夏天', exact: true }).click()
  await waitForStableIndicator(h)
  const target = await h.page.evaluate(async id => (await window.api.listBooks()).find(book => book.id === id)!.lastReadCfi!, first.id)
  await h.page.getByRole('button', { name: '← 书架', exact: true }).click()
  await h.page.getByRole('button', { name: `打开《${second.title}》`, exact: true }).click()
  await waitForLocationsReady(h)
  await expect.poll(() => h.page.evaluate(async () => (await window.api.listBooks())[0].id)).toBe(second.id)
  await h.page.getByRole('button', { name: '← 书架', exact: true }).click()
  await expect(h.page.getByTestId('continue-reading')).toContainText(second.title)
  // 回到第一本，仅恢复位置、不翻页，然后离开；最近阅读仍必须切回第一本。
  await h.page.getByRole('button', { name: `打开《${first.title}》`, exact: true }).click()
  await waitForLocationsReady(h)
  await waitForStableIndicator(h)
  await expect.poll(() => h.page.evaluate(async () => (await window.api.listBooks())[0].id)).toBe(first.id)
  await h.page.getByRole('button', { name: '← 书架', exact: true }).click()
  await h.app.close()
  h = await launch(h.userData)
  await expect(h.page.getByTestId('continue-reading')).toContainText(first.title)
  await h.page.getByTestId('continue-reading').click()
  await waitForLocationsReady(h)
  await waitForStableIndicator(h)
  const visible = await h.page.evaluate(() => {
    const location = (window as any).__readerRendition.location
    return { start: location.start.cfi, end: location.end.cfi }
  })
  expect(compareCfi(visible.start, target)).toBeLessThanOrEqual(0)
  expect(compareCfi(visible.end, target)).toBeGreaterThanOrEqual(0)
  await h.page.getByRole('button', { name: '← 书架', exact: true }).click()
  await h.page.getByRole('button', { name: `删除《${first.title}》`, exact: true }).click()
  await h.page.getByTestId('confirm-delete-yes').click()
  await expect(h.page.getByTestId('continue-reading')).toContainText(second.title)
})
