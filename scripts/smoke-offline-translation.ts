// Explicit network smoke check only; never run as part of npm test or touch the real profile.
import { appendFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { createTranslationService } from '../src/main/translation'

const directory = await mkdtemp(join(tmpdir(), 'mowen-offline-smoke-'))
let lastProgress = -1
const service = createTranslationService({
  directory,
  getSetting: (key) => key === 'translation.mode' ? 'offline' : null,
  workerPath: resolve('out/main/translation-worker.js'),
  onChanged: (snapshot) => {
    const step = Math.floor(snapshot.received / 20_000_000)
    if (step !== lastProgress) { lastProgress = step; console.log(snapshot.status, snapshot.received, '/', snapshot.total) }
  }
})
try {
  assert.equal((await service.downloadPack()).status, 'installed', service.snapshot().message ?? 'download failed')
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('Network forbidden during offline smoke check') }
  try {
    const translated = await service.translate('The reader opened the book and began to read.')
    assert.equal(translated.engine, 'offline')
    assert.match(translated.text, /[\u3400-\u9fff]/)
    console.log('Offline translation verified:', translated.text)
  } finally { globalThis.fetch = originalFetch }
  console.log('Temporary model directory for Electron smoke check:', directory)
  if (process.env.GITHUB_ENV) await appendFile(process.env.GITHUB_ENV, `READER_OFFLINE_SMOKE_PATH=${directory}\n`)
} finally { service.dispose() }
