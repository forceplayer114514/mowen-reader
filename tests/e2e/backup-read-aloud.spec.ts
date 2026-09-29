import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeAllApps, importFixture, launch, waitForLocationsReady } from './helpers'
import { buildFixturePdf } from '../../scripts/make-fixture-pdf'

test.afterEach(closeAllApps)

test('settings can create a complete sync-folder backup and reader can control system speech', async () => {
  const h = await launch()
  await importFixture(h)
  const cloud = join(h.userData, 'fake-cloud')
  mkdirSync(cloud)
  writeFileSync(join(h.userData, 'backup-location.json'), JSON.stringify({ folder: cloud, lastBackup: null }))
  await h.page.getByTestId('open-settings').click()
  await expect(h.page.getByTestId('backup-settings')).toContainText(cloud)
  await h.page.getByTestId('backup-create').click()
  await expect(h.page.getByTestId('backup-status')).toContainText('完整备份已保存')
  const backup = readdirSync(cloud).find((name) => name.startsWith('墨问备份-'))
  expect(backup).toBeTruthy()
  expect(readdirSync(join(cloud, backup!))).toContain('reader.db')
  expect(readdirSync(join(cloud, backup!, 'books'))).toHaveLength(1)

  await h.page.evaluate(() => {
    const synth = {
      getVoices: () => [], addEventListener: () => {}, removeEventListener: () => {},
      speak: () => {}, pause: () => {}, resume: () => {}, cancel: () => {}
    }
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synth })
  })
  await h.page.getByRole('button', { name: '← 返回书架' }).click()
  await h.page.getByTestId('book-card').click()
  await waitForLocationsReady(h)
  await h.page.getByTestId('read-aloud-toggle').click()
  await h.page.getByTestId('read-aloud-play').click()
  await expect(h.page.getByTestId('read-aloud-play')).toHaveText('暂停')
  await h.page.getByTestId('read-aloud-play').click()
  await expect(h.page.getByTestId('read-aloud-play')).toHaveText('继续')
  await h.page.getByTestId('read-aloud-stop').click()
  await expect(h.page.getByTestId('read-aloud-play')).toHaveText('开始朗读')
  const before = await h.page.getByTestId('page-indicator').textContent()
  await h.page.evaluate(() => {
    window.speechSynthesis.speak = (utterance) => {
      setTimeout(() => utterance.onend?.(new Event('end') as SpeechSynthesisEvent), 5)
    }
  })
  await h.page.getByTestId('read-aloud-play').click()
  await expect(h.page.getByTestId('page-indicator')).not.toHaveText(before!, { timeout: 15_000 })
  await h.page.getByTestId('read-aloud-stop').click()
  await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 600))
  expect(await h.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('clicking a word starts reading there rather than at the page beginning', async () => {
  const h = await launch()
  await h.page.evaluate(() => {
    ;(window as any).__spoken = []
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      getVoices: () => [], addEventListener: () => {}, removeEventListener: () => {},
      speak: (utterance: SpeechSynthesisUtterance) => (window as any).__spoken.push(utterance.text),
      pause: () => {}, resume: () => {}, cancel: () => {}
    } })
  })
  await importFixture(h)
  await h.page.getByTestId('book-card').click()
  await waitForLocationsReady(h)
  await h.page.getByTestId('read-aloud-toggle').click()
  await h.page.getByTestId('read-aloud-pick').click()
  await expect(h.page.getByTestId('read-aloud-pick')).toHaveText('取消点选')
  await h.page.evaluate(() => {
    const doc = document.querySelector<HTMLIFrameElement>('[data-testid="reader-page"] iframe')!.contentDocument!
    const node = doc.querySelector('p')!.firstChild!
    const range = doc.createRange()
    range.setStart(node, 24); range.setEnd(node, 25)
    const rect = range.getBoundingClientRect()
    doc.querySelector('p')!.dispatchEvent(new doc.defaultView!.MouseEvent('click', {
      bubbles: true, button: 0, clientX: rect.left + 1, clientY: rect.top + rect.height / 2
    }))
  })
  await expect.poll(() => h.page.evaluate(() => (window as any).__spoken[0] ?? '')).toContain('正文')
  expect(await h.page.evaluate(() => (window as any).__spoken[0])).not.toContain('开端的第1段')
  await expect(h.page.getByTestId('read-aloud-play')).toHaveText('暂停')
})

test('PDF read-aloud starts at a clicked word in the text layer', async () => {
  const h = await launch()
  await h.page.evaluate(() => {
    ;(window as any).__spoken = []
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      getVoices: () => [], addEventListener: () => {}, removeEventListener: () => {},
      speak: (utterance: SpeechSynthesisUtterance) => (window as any).__spoken.push(utterance.text),
      pause: () => {}, resume: () => {}, cancel: () => {}
    } })
  })
  const path = join(h.userData, 'speech.pdf')
  writeFileSync(path, buildFixturePdf())
  await h.page.evaluate((file) => { (window as any).__E2E_FILES__ = [file] }, path)
  await h.page.getByTestId('pick-files').click()
  await h.page.getByTestId('book-card').click()
  await waitForLocationsReady(h)
  await h.page.getByTestId('read-aloud-toggle').click()
  await h.page.getByTestId('read-aloud-pick').click()
  await h.page.evaluate(() => {
    const doc = document.querySelector<HTMLIFrameElement>('.pdf-reader__frame')!.contentDocument!
    const span = doc.querySelectorAll('.textLayer span')[1]
    const node = span.firstChild!
    const range = doc.createRange()
    range.setStart(node, 11); range.setEnd(node, 12)
    const rect = range.getBoundingClientRect()
    span.dispatchEvent(new doc.defaultView!.MouseEvent('click', {
      bubbles: true, button: 0, clientX: rect.left + 1, clientY: rect.top + rect.height / 2
    }))
  })
  await expect.poll(() => h.page.evaluate(() => (window as any).__spoken[0] ?? '')).toContain('text for translation')
  expect(await h.page.evaluate(() => (window as any).__spoken[0])).not.toContain('PDF Reading Test')
})
