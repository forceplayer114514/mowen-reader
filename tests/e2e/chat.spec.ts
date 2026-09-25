import { expect, test } from '@playwright/test'
import {
  chapterHighlights,
  chapterQuotes,
  closeAllApps,
  configureLlm,
  dragSelectAcrossParagraphs,
  enableSelectionStore,
  importFixture,
  launch,
  pressUntilPageChanges,
  slowDragSelectInChapter,
  waitForLocationsReady,
  type Harness
} from './helpers'
import { closeAllFakeLlms, startFakeLlm, type FakeLlm } from './fake-llm'

test.afterEach(async () => {
  await closeAllApps()
  await closeAllFakeLlms()
})

async function openBook(h: Harness, fake?: FakeLlm, selection = false): Promise<void> {
  if (selection) await enableSelectionStore(h)
  await importFixture(h)
  if (fake) await configureLlm(h, { endpoint: fake.url })
  await h.page.getByTestId('book-card').first().click()
  await h.page.getByTestId('reader-page').waitFor()
  await waitForLocationsReady(h)
}

async function ask(h: Harness, text: string): Promise<void> {
  await h.page.getByTestId('chat-input').fill(text)
  await h.page.getByTestId('chat-send').click()
  await expect.poll(() => h.page.getByTestId('message-assistant').count(), { timeout: 20_000 }).toBeGreaterThan(0)
  await expect(h.page.getByTestId('message-assistant').last()).toContainText('这是假的回答。', { timeout: 20_000 })
}

test('未配置密钥时发送提示去设置且假服务没有收到请求', async () => {
  const h = await launch()
  const fake = await startFakeLlm()
  await openBook(h)
  await configureLlm(h, { endpoint: fake.url, apiKey: '' })
  await h.page.getByTestId('book-card').first().click()
  await h.page.getByTestId('reader-page').waitFor()
  await waitForLocationsReady(h)
  await h.page.getByTestId('chat-input').fill('没有密钥也不能发')
  await h.page.getByTestId('chat-send').click()
  await expect(h.page.getByTestId('chat-error')).toContainText('API 密钥')
  expect(fake.requests).toHaveLength(0)
})

test('配置后提问会逐字得到完整回答', async () => {
  const h = await launch()
  const fake = await startFakeLlm()
  await openBook(h, fake)
  await ask(h, '这本书讲了什么？')
  expect(fake.requests).toHaveLength(1)
})

test('假服务收到的 system 上下文含书名作者和当前页正文', async () => {
  const h = await launch()
  const fake = await startFakeLlm()
  await openBook(h, fake)
  await ask(h, '请概括这一页')
  const system = fake.requests[0]?.body.messages?.find((m) => m.role === 'system')?.content ?? ''
  expect(system).toContain('测试之书')
  expect(system).toContain('测试作者')
  expect(system).toContain('当前页内容:')
  expect(system).toContain('开端的第1段')
})

test('划选原文后提问,假服务的 user 消息含引用', async () => {
  const h = await launch()
  const fake = await startFakeLlm()
  await openBook(h, fake, true)
  await dragSelectAcrossParagraphs(h)
  const quote = (await chapterQuotes(h))[0]
  expect(quote?.text).toBeTruthy()
  await ask(h, '请解释这句话')
  const user = fake.requests[0]?.body.messages?.at(-1)?.content ?? ''
  expect(user).toContain(quote!.text)
})

test('点击已高亮句子取消后,请求不再带该引用', async () => {
  const h = await launch()
  const fake = await startFakeLlm()
  await openBook(h, fake, true)
  await dragSelectAcrossParagraphs(h)
  const quote = (await chapterQuotes(h))[0]
  await h.page.getByTestId('quote-chip').click()
  await expect(h.page.getByTestId('quote-chip')).toHaveCount(0)
  await ask(h, '不带引用提问')
  const user = fake.requests[0]?.body.messages?.at(-1)?.content ?? ''
  expect(user).not.toContain(quote!.text)
})

test('发送完成后页面高亮被清除', async () => {
  const h = await launch()
  const fake = await startFakeLlm()
  await openBook(h, fake, true)
  await dragSelectAcrossParagraphs(h)
  await expect(chapterHighlights(h)).toHaveCount(1)
  await ask(h, '发送后清除')
  await expect(h.page.getByTestId('quote-chip')).toHaveCount(0)
  await expect(chapterHighlights(h)).toHaveCount(0)
})

test('翻译悬浮在对应引用上方，且不会改变阅读位置', async () => {
  const h = await launch()
  const fake = await startFakeLlm()
  await openBook(h, fake, true)
  const before = await h.page.getByTestId('page-indicator').textContent()
  await slowDragSelectInChapter(h)
  await dragSelectAcrossParagraphs(h)
  const quotes = await chapterQuotes(h)
  const chip = h.page.getByTestId('quote-chip').nth(1)
  const translate = h.page.getByTestId('quote-translate').nth(1)
  await expect(translate).toBeHidden()
  await chip.hover()
  await expect(translate).toBeVisible()
  const chipBox = await chip.boundingBox()
  const translateBox = await translate.boundingBox()
  expect(translateBox!.y + translateBox!.height).toBeLessThanOrEqual(chipBox!.y + 3)
  await translate.click()
  await expect(h.page.getByTestId('message-assistant').last()).toContainText('这是假的回答。', {
    timeout: 20_000
  })
  const sent = fake.requests[0]?.body.messages?.at(-1)?.content ?? ''
  expect(sent).toContain(quotes[1].text)
  expect(sent).not.toContain(quotes[0].text)
  await expect(h.page.getByTestId('page-indicator')).toHaveText(before!)
})

test('停止慢速回答后保留已输出内容,重开仍可见', async () => {
  const h = await launch()
  const fake = await startFakeLlm()
  fake.setMode('slow')
  await openBook(h, fake)
  await h.page.getByTestId('chat-input').fill('慢慢回答')
  await h.page.getByTestId('chat-send').click()
  await expect(h.page.getByTestId('chat-stop')).toBeVisible()
  await expect(h.page.getByTestId('message-assistant').last()).not.toHaveText('', { timeout: 20_000 })
  const partial = await h.page.getByTestId('message-assistant').last().textContent()
  await h.page.getByTestId('chat-stop').click()
  await expect(h.page.getByTestId('chat-stop')).toHaveCount(0)
  await expect(h.page.getByTestId('message-assistant').last()).toContainText(partial!.trim())
  await h.page.getByRole('button', { name: '← 书架' }).click()
  await h.page.getByTestId('book-card').first().click()
  await h.page.getByTestId('reader-page').waitFor()
  await expect(h.page.getByTestId('message-assistant').last()).toContainText(partial!.trim(), { timeout: 30_000 })
})

test('401 显示密钥相关中文提示,重试会再次发请求', async () => {
  const h = await launch()
  const fake = await startFakeLlm()
  await openBook(h, fake)
  fake.setMode('401')
  await h.page.getByTestId('chat-input').fill('触发鉴权错误')
  await h.page.getByTestId('chat-send').click()
  await expect(h.page.getByTestId('chat-error')).toContainText('API 密钥无效')
  expect(fake.requests).toHaveLength(1)
  fake.setMode('normal')
  await h.page.getByTestId('chat-retry').click()
  await expect.poll(() => fake.requests.length, { timeout: 20_000 }).toBe(2)
  await expect(h.page.getByTestId('message-assistant').last()).toContainText('这是假的回答。', { timeout: 20_000 })
})

test('429 和连接被拒绝都会显示可操作的中文提示', async () => {
  const h = await launch()
  const fake = await startFakeLlm()
  await openBook(h, fake)
  fake.setMode('429')
  await h.page.getByTestId('chat-input').fill('触发限流')
  await h.page.getByTestId('chat-send').click()
  await expect(h.page.getByTestId('chat-error')).toContainText(/额度|频繁/)
  await expect(h.page.getByTestId('chat-retry')).toBeVisible()

  fake.setMode('refuse')
  await h.page.getByTestId('chat-retry').click()
  await expect(h.page.getByTestId('chat-error')).toContainText(/连不上|接口地址/)
  expect(fake.requests).toHaveLength(1)
})

test('移动阅读位置不会中断当前对话', async () => {
  const h = await launch()
  const fake = await startFakeLlm()
  await openBook(h, fake)
  await ask(h, '记住这一页')
  await pressUntilPageChanges(h, 'ArrowRight')
  await expect(h.page.getByTestId('message-user')).toContainText('记住这一页')
  await pressUntilPageChanges(h, 'ArrowLeft')
  await expect(h.page.getByTestId('message-assistant').last()).toContainText('这是假的回答。', { timeout: 20_000 })
})

test('当前页没有消息就翻页,不会产生对话记录', async () => {
  const h = await launch()
  await openBook(h)
  await pressUntilPageChanges(h, 'ArrowRight')
  await expect(h.page.getByTestId('page-conversations-summary')).toContainText('0 个对话')
})

test('改字号并翻回原文位置后,CFI 锚定的对话仍出现', async () => {
  const h = await launch()
  const fake = await startFakeLlm()
  await openBook(h, fake)
  await ask(h, '这段文字的对话应跟随 CFI')
  await h.page.getByRole('button', { name: '放大字号' }).click()
  await expect(h.page.getByTestId('message-assistant').last()).toContainText('这是假的回答。')
  await pressUntilPageChanges(h, 'ArrowRight')
  await pressUntilPageChanges(h, 'ArrowLeft')
  await expect(h.page.getByTestId('message-assistant').last()).toContainText('这是假的回答。', { timeout: 20_000 })
})

test('新建对话保留旧记录，空对话无需确认', async () => {
  const h = await launch()
  const fake = await startFakeLlm()
  await openBook(h, fake)
  let dialogs = 0
  const countDialog = () => { dialogs++ }
  h.page.on('dialog', countDialog)
  await h.page.getByTestId('new-conversation').click()
  await h.page.waitForTimeout(100)
  expect(dialogs).toBe(0)
  h.page.off('dialog', countDialog)

  await ask(h, '准备删除的对话')
  await h.page.getByTestId('new-conversation').click()
  await expect(h.page.getByTestId('message-user')).toHaveCount(0)
  await expect.poll(() => h.page.getByTestId('page-conversations-summary').textContent()).toContain('1 个对话')
})

test('侧栏显示本章对话,可定位、切换和删除', async () => {
  const h = await launch()
  const fake = await startFakeLlm()
  await openBook(h, fake)
  await ask(h, '第一页对话')
  const sidebar = h.page.getByTestId('sidebar')
  await expect(sidebar.getByText('当前位置')).toBeVisible()
  await expect(sidebar.getByText('全书对话')).toHaveCount(0)
  await expect(sidebar.getByText('《测试之书》')).toHaveCount(0)
  await expect(h.page.getByTestId('page-conversations-summary')).toContainText('本章 1 个对话')

  await pressUntilPageChanges(h, 'ArrowRight')
  await h.page.getByTestId('new-conversation').click()
  await ask(h, '第二页对话')
  await expect(h.page.getByTestId('page-conversations-summary')).toContainText('本章 2 个对话')
  await expect(h.page.getByTestId('history-entry')).toHaveCount(2)

  await h.page.getByRole('button', { name: /定位对话/ }).first().click()
  await h.page.getByTestId('history-entry').first().click()
  await expect(h.page.getByTestId('message-user')).toContainText('第一页对话')

  await h.page.getByTestId('history-entry').first().hover()
  await h.page.getByTestId('history-delete').first().click()
  await h.page.getByTestId('confirm-history-delete-yes').click()
  await expect(h.page.getByTestId('page-conversations-summary')).toContainText('本章 1 个对话')
  await expect(h.page.getByTestId('message-user')).toHaveCount(0)
})

test('对话管理页能看到全部对话并批量删除,侧边栏历史随之清空', async () => {
  const h = await launch()
  const fake = await startFakeLlm()
  await openBook(h, fake)
  await ask(h, '第一段对话')
  await pressUntilPageChanges(h, 'ArrowRight')
  await h.page.getByTestId('new-conversation').click()
  await ask(h, '第二段对话')
  await h.page.getByRole('button', { name: '← 书架' }).click()
  await h.page.getByTestId('open-conversations').click()
  await expect(h.page.getByTestId('conversation-book')).toHaveCount(1)
  await h.page.getByTestId('conversation-book').click()
  await expect(h.page.getByTestId('conversation-row')).toHaveCount(2)
  await h.page.locator('.conversations__select-all input').check()
  await h.page.getByTestId('conversation-delete').click()
  await h.page.getByTestId('confirm-conversations-delete-yes').click()
  await expect(h.page.getByText('这本书还没有对话。')).toBeVisible({ timeout: 20_000 })
  await h.page.getByRole('button', { name: '← 对话书架' }).click()
  await h.page.getByRole('button', { name: '← 返回书架' }).click()
  await h.page.getByTestId('book-card').first().click()
  await expect(h.page.getByTestId('page-conversations-summary')).toContainText('0 个对话', { timeout: 20_000 })
})

test('对话书架按书进入，章节可以展开和收起', async () => {
  const h = await launch()
  const fake = await startFakeLlm()
  await openBook(h, fake)
  await ask(h, '第一章的问题')
  await h.page.getByTestId('toggle-toc').click()
  await h.page.getByTestId('toc').getByText('第二章 那个夏天').click()
  await expect(h.page.getByTestId('reader-foot')).toContainText('第二章 那个夏天')
  await h.page.getByTestId('new-conversation').click()
  await ask(h, '第二章的问题')
  await h.page.getByRole('button', { name: '← 书架' }).click()
  await h.page.getByTestId('open-conversations').click()
  await expect(h.page.getByTestId('conversation-book')).toContainText('2 个对话')
  await h.page.getByTestId('conversation-book').click()
  const chapters = h.page.getByTestId('chapter-group')
  await expect(chapters).toHaveCount(2)
  await expect(chapters.nth(0)).toHaveAttribute('open', '')
  await expect(chapters.nth(1)).not.toHaveAttribute('open')
  await chapters.nth(1).getByTestId('chapter-toggle').click()
  await expect(chapters.nth(1)).toHaveAttribute('open', '')
  await chapters.nth(0).getByTestId('chapter-toggle').click()
  await expect(chapters.nth(0)).not.toHaveAttribute('open')
  await chapters.nth(1).locator('.conversation-row input').check()
  await expect(chapters.nth(0)).not.toHaveAttribute('open')
})

test('删除一本书会级联删除它的全部对话', async () => {
  const h = await launch()
  const fake = await startFakeLlm()
  await openBook(h, fake)
  await ask(h, '随书删除')
  await h.page.getByRole('button', { name: '← 书架' }).click()
  await h.page.getByTestId('delete-book').click()
  await h.page.getByTestId('confirm-delete-yes').click()
  await expect(h.page.getByTestId('book-card')).toHaveCount(0)
  await h.page.getByTestId('open-conversations').click()
  await expect(h.page.getByText('书架是空的，先添加一本书吧。')).toBeVisible({ timeout: 20_000 })
})
