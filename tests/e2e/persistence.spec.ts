import { expect, test } from '@playwright/test'
import { closeAllApps, configureLlm, enableSelectionStore, importFixture, launch,
  slowDragSelectInChapter, waitForLocationsReady, waitForStableIndicator, type Harness } from './helpers'
import { closeAllFakeLlms, startFakeLlm } from './fake-llm'
import { compareCfi } from '../../src/renderer/reader/cfi'

test.afterEach(async () => { await closeAllApps(); await closeAllFakeLlms() })

async function open(h: Harness): Promise<void> {
  await h.page.getByTestId('book-card').first().click()
  await waitForLocationsReady(h)
  await waitForStableIndicator(h)
}

async function snapshot(h: Harness) {
  return h.page.evaluate(async () => {
    const books = await window.api.listBooks()
    const book = books[0]
    const conversations = await window.api.listConversations(book.id)
    return { books, notes: await window.api.listAnnotations(book.id),
      bookmarks: await window.api.listBookmarks(book.id), conversations,
      messages: await Promise.all(conversations.map((c) => window.api.listMessages(c.id))) }
  })
}

test('反复切书/关窗重开、字号改变及坏缓存重算均保留位置和结构化记录', async () => {
  test.setTimeout(120_000)
  let h = await launch()
  const fake = await startFakeLlm()
  await configureLlm(h, { endpoint: fake.url })
  await enableSelectionStore(h)
  await importFixture(h)
  await open(h)
  await h.page.getByTestId('bookmark-toggle').click()
  await slowDragSelectInChapter(h)
  await h.page.getByTestId('quote-chip').hover()
  await h.page.getByTestId('quote-annotate').click()
  await h.page.getByTestId('annotation-input').fill('重启后保留的注释')
  await h.page.getByTestId('annotation-submit').click()
  await expect(h.page.getByTestId('annotation-target')).toHaveCount(0)
  await h.page.getByTestId('chat-input').fill('持久化测试')
  await h.page.getByTestId('chat-send').click()
  await expect(h.page.getByTestId('message-assistant').last()).toContainText('这是假的回答。')
  await expect(h.page.getByTestId('chat-stop')).toHaveCount(0)
  const initial = await snapshot(h)
  expect(initial.notes).toHaveLength(1)
  expect(initial.messages[0]).toHaveLength(2)
  await h.page.getByTestId('toggle-toc').click()
  await h.page.getByRole('button', { name: '第二章' }).click()
  await waitForStableIndicator(h)
  for (let i = 0; i < 4; i++) await h.page.getByRole('button', { name: '放大字号' }).click()
  await waitForStableIndicator(h)
  const target = (await snapshot(h)).books[0].lastReadCfi!
  expect(target).toContain('epubcfi(')
  await h.page.evaluate(async () => {
    const [book] = await window.api.listBooks()
    await window.api.saveLocations(book.id, '{broken')
  })
  for (let i = 0; i < 3; i++) {
    if (i === 0) await h.page.getByRole('button', { name: '← 书架' }).click()
    else { await h.app.close(); h = await launch(h.userData) }
    await expect(h.page.getByTestId('book-card')).toHaveCount(1)
    await open(h)
    const state = await snapshot(h)
    expect(state.notes).toEqual(initial.notes)
    expect(state.bookmarks).toEqual(initial.bookmarks)
    expect(state.conversations).toEqual(initial.conversations)
    expect(state.messages).toEqual(initial.messages)
    const visible = await h.page.evaluate(() => {
      const loc = (window as any).__readerRendition.location
      return { start: loc.start.cfi, end: loc.end.cfi }
    })
    expect(compareCfi(visible.start, target)).toBeLessThanOrEqual(0)
    expect(compareCfi(visible.end, target)).toBeGreaterThanOrEqual(0)
    expect(state.books[0].lastReadCfi).toBe(target)
    expect(await h.page.evaluate(async () => window.api.getLocations((await window.api.listBooks())[0].id))).not.toBeNull()
  }
})

test('回答中途强制终止进程，已显示内容在 WAL 恢复后仍在且不重复', async () => {
  const h = await launch()
  const fake = await startFakeLlm()
  fake.setMode('slow')
  await configureLlm(h, { endpoint: fake.url })
  await importFixture(h)
  await open(h)
  await h.page.getByTestId('chat-input').fill('回答中退出')
  await h.page.getByTestId('chat-send').click()
  await expect(h.page.getByTestId('message-assistant').last()).toContainText('这')
  const shown = (await h.page.getByTestId('message-assistant').last().textContent())!.trim()
  const before = await snapshot(h)
  expect(before.messages[0]).toHaveLength(2)
  expect(before.messages[0][1].content).toContain(shown)
  // 仅终止本测试的隔离进程；不触及用户正在运行的软件或真实书库。
  process.kill(h.app.process().pid!, 'SIGKILL')
  const again = await launch(h.userData)
  const after = await snapshot(again)
  expect(after.messages[0]).toHaveLength(2)
  expect(after.messages[0][1].id).toBe(before.messages[0][1].id)
  expect(after.messages[0][1].content).toContain(shown)
  await open(again)
  await expect(again.page.getByTestId('message-assistant')).toHaveCount(1)
  await expect(again.page.getByTestId('message-assistant')).toContainText(shown)
})

test('阅读位置写盘失败明确提示，后续翻页重试成功后恢复', async () => {
  const h = await launch()
  await importFixture(h)
  await open(h)
  await h.app.evaluate(({ ipcMain }) => {
    const handler = (ipcMain as any)._invokeHandlers.get('books:saveProgress')
    ipcMain.removeHandler('books:saveProgress')
    let fail = true
    ipcMain.handle('books:saveProgress', (...args: unknown[]) => {
      if (fail) { fail = false; throw new Error('test disk error') }
      return handler(...args)
    })
  })
  await h.page.getByRole('button', { name: '下一页', exact: true }).click()
  await expect(h.page.getByText('阅读位置保存失败，请翻页后重试', { exact: true })).toBeVisible()
  await waitForStableIndicator(h)
  await h.page.getByRole('button', { name: '下一页', exact: true }).click()
  await expect(h.page.getByText('阅读位置保存失败，请翻页后重试', { exact: true })).toHaveCount(0)
  await waitForStableIndicator(h)
  const cfi = (await snapshot(h)).books[0].lastReadCfi
  await h.app.close()
  const again = await launch(h.userData)
  expect((await snapshot(again)).books[0].lastReadCfi).toBe(cfi)
  await open(again)
})

test('读取历史碰上流式回答时只显示一个回答，旧快照不覆盖完整内容', async () => {
  const h = await launch()
  const fake = await startFakeLlm()
  fake.setMode('slow')
  await configureLlm(h, { endpoint: fake.url })
  await importFixture(h)
  await open(h)
  await h.app.evaluate(({ ipcMain }) => {
    const handler = (ipcMain as any)._invokeHandlers.get('chat:listMessages')
    ipcMain.removeHandler('chat:listMessages')
    ipcMain.handle('chat:listMessages', async (...args: unknown[]) => {
      await new Promise((resolve) => setTimeout(resolve, 300))
      const partial = handler(...args)
      await new Promise((resolve) => setTimeout(resolve, 500))
      return partial
    })
  })
  await h.page.getByTestId('chat-input').fill('读取与回答同时进行')
  await h.page.getByTestId('chat-send').click()
  await expect(h.page.getByTestId('message-assistant')).toContainText('这是假的')
  await expect(h.page.getByTestId('message-assistant')).toHaveCount(1)
  await expect(h.page.getByTestId('chat-stop')).toHaveCount(0)
  await expect(h.page.getByTestId('message-assistant')).toHaveCount(1)
  await expect(h.page.getByTestId('message-assistant')).toContainText('这是假的回答。')
})

test('读取书库或对话失败时不伪装成空库，重试后原记录恢复', async () => {
  const h = await launch()
  const fake = await startFakeLlm()
  await configureLlm(h, { endpoint: fake.url })
  await importFixture(h)
  await open(h)
  await h.page.getByTestId('chat-input').fill('保留的记录')
  await h.page.getByTestId('chat-send').click()
  await expect(h.page.getByTestId('message-assistant')).toContainText('这是假的回答。')
  await expect(h.page.getByTestId('chat-stop')).toHaveCount(0)
  const before = await snapshot(h)
  await h.app.evaluate(({ ipcMain }) => {
    for (const name of ['books:list', 'chat:listMessages']) {
      const handler = (ipcMain as any)._invokeHandlers.get(name)
      ipcMain.removeHandler(name)
      let fail = true
      ipcMain.handle(name, (...args: unknown[]) => {
        if (fail) { fail = false; throw new Error('test read error') }
        return handler(...args)
      })
    }
  })
  await h.page.getByRole('button', { name: '← 书架' }).click()
  await expect(h.page.getByText('书库暂时无法读取', { exact: true })).toBeVisible()
  await expect(h.page.getByText('书架是空的', { exact: true })).toHaveCount(0)
  await h.page.getByRole('button', { name: '重新读取书库' }).click()
  await expect(h.page.getByTestId('book-card')).toHaveCount(1)
  await open(h)
  await expect(h.page.getByTestId('sidebar-error')).toContainText('对话读取失败')
  await h.page.getByRole('button', { name: '← 书架' }).click()
  await open(h)
  await expect(h.page.getByTestId('message-assistant')).toContainText('这是假的回答。')
  expect((await snapshot(h)).messages).toEqual(before.messages)
})

test('字号重排失败后释放锚点锁，后续翻页继续保存新位置', async () => {
  const h = await launch()
  await importFixture(h)
  await open(h)
  await h.page.getByRole('button', { name: '下一页', exact: true }).click()
  await waitForStableIndicator(h)
  const before = (await snapshot(h)).books[0].lastReadCfi
  await h.page.evaluate(() => {
    const r = (window as any).__readerRendition
    const original = r.display.bind(r)
    r.display = () => {
      r.display = original
      return Promise.reject(new Error('test layout failure'))
    }
  })
  await h.page.getByRole('button', { name: '放大字号' }).click()
  await expect(h.page.getByText('字号调整失败，请重试', { exact: true })).toBeVisible()
  await waitForStableIndicator(h)
  await h.page.getByRole('button', { name: '下一页', exact: true }).click()
  await waitForStableIndicator(h)
  await expect.poll(async () => (await snapshot(h)).books[0].lastReadCfi).not.toBe(before)
})
