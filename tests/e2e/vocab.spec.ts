import { expect, test } from '@playwright/test'
import { closeAllApps, enableSelectionStore, importFixture, launch, slowDragSelectInChapter, waitForLocationsReady } from './helpers'
import { closeFakeTranslations, startFakeTranslation } from './fake-translation'

test.afterEach(async () => { await closeAllApps(); await closeFakeTranslations() })

test('翻译可收藏为生词，重启后仍可定位及删除', async () => {
  const translator = await startFakeTranslation()
  let h = await launch(undefined, { READER_TRANSLATION_TEST_URL: translator.url })
  await h.page.evaluate(() => window.api.setSetting('translation.onlineConsent', 'true'))
  await enableSelectionStore(h)
  await importFixture(h)
  await h.page.getByTestId('book-card').first().click()
  await waitForLocationsReady(h)
  await slowDragSelectInChapter(h)
  const original = await h.page.getByTestId('quote-chip').textContent()
  await h.page.getByTestId('quote-chip').hover()
  await h.page.getByTestId('quote-translate').click()
  await expect(h.page.getByTestId('message-assistant')).toContainText('这是独立翻译结果。')
  await h.page.evaluate(() => {
    ;(window as any).__spoken = []
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      getVoices: () => [], addEventListener: () => {}, removeEventListener: () => {},
      speak: (utterance: SpeechSynthesisUtterance) => (window as any).__spoken.push(utterance.text),
      pause: () => {}, resume: () => {}, cancel: () => {}
    } })
  })
  await h.page.getByTestId('read-aloud-toggle').click()
  await h.page.getByTestId('read-aloud-play').click()
  await expect(h.page.getByTestId('read-aloud-play')).toHaveText('暂停')
  await h.page.getByTestId('translation-speak').click()
  await expect(h.page.getByTestId('read-aloud-play')).toHaveText('开始朗读')
  await expect.poll(() => h.page.evaluate(() => (window as any).__spoken.at(-1) ?? '')).toContain(original!.replace(/[「」×]/g, '').trim())
  expect(await h.page.evaluate(() => (window as any).__spoken.at(-1))).not.toContain('翻译〕')
  await h.page.getByTestId('translation-speak').click()
  await h.page.getByTestId('vocab-save').click()
  await expect(h.page.getByTestId('vocab-save')).toContainText('已收藏')
  await h.page.getByTestId('sidebar-tab-vocab').click()
  await expect(h.page.getByTestId('vocab-card')).toContainText('这是独立翻译结果。')
  const userData = h.userData
  await h.app.close()

  h = await launch(userData, { READER_TRANSLATION_TEST_URL: translator.url })
  await h.page.getByTestId('book-card').first().click()
  await waitForLocationsReady(h)
  await h.page.getByTestId('sidebar-tab-vocab').click()
  await expect(h.page.getByTestId('vocab-card')).toHaveCount(1)
  await h.page.getByTestId('vocab-locate').click()
  await expect(h.page.getByTestId('page-indicator')).toBeVisible()
  await h.page.getByTestId('vocab-delete').click()
  await h.page.getByTestId('confirm-vocab-delete-yes').click()
  await expect(h.page.getByTestId('vocab-card')).toHaveCount(0)
})
