// Exercise the shipped OCR worker and its nested WASM worker from the actual ASAR.
const assert = require('node:assert/strict')
const { join, resolve } = require('node:path')
const { spawnSync } = require('node:child_process')
const { createRequire } = require('node:module')
const { mkdtempSync, mkdirSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { Worker } = require('node:worker_threads')

if (process.argv[2] !== '--inside') {
  const root = process.platform === 'darwin'
    ? resolve('release', process.arch === 'arm64' ? 'mac-arm64' : 'mac', '墨问.app', 'Contents')
    : resolve('release/win-unpacked')
  const executable = process.platform === 'darwin' ? join(root, 'MacOS/墨问') : join(root, '墨问.exe')
  const asar = join(root, process.platform === 'darwin' ? 'Resources' : 'resources', 'app.asar')
  const result = spawnSync(executable, [__filename, '--inside', asar], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 300_000
  })
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  assert.ifError(result.error)
  assert.equal(result.status, 0, 'Packaged OCR smoke failed')
} else {
  void (async () => {
    const asar = process.argv[3]
    const requireApp = createRequire(join(asar, 'package.json'))
    const sharp = requireApp('sharp')
    const modelDir = mkdtempSync(join(tmpdir(), 'mowen-packaged-ocr-'))
    const tempDir = join(modelDir, '.download-test'); mkdirSync(tempDir)
    let worker
    try {
      const width = 1000, height = 150
      const image = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
        <rect width="100%" height="100%" fill="white"/>
        <text x="30" y="100" font-family="sans-serif" font-size="60" fill="black">READER OCR TEST 123</text>
        </svg>`)).png().toBuffer()
      worker = new Worker(join(asar, 'out/main/pdf-ocr-worker.js'))
      const message = await new Promise((resolveResult, reject) => {
        const timer = setTimeout(() => reject(new Error('Packaged OCR timed out')), 240_000)
        const finish = (error, result) => {
          clearTimeout(timer)
          if (error) reject(error)
          else resolveResult(result)
        }
        worker.once('error', error => finish(error))
        worker.once('exit', code => finish(new Error(`OCR worker exited before result (${code})`)))
        worker.on('message', reply => {
          if (reply.type === 'result') finish(null, reply)
          else if (reply.type === 'error') finish(new Error(reply.status))
        })
        worker.postMessage({ image: image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength),
          width, height, region: null, language: 'chi_sim+eng', modelDir, tempDir })
      })
      assert.match(message.text, /READER/i)
      assert.match(message.text, /123/)
      assert.ok(message.words.length >= 4, 'OCR must return selectable word boxes')
      assert.ok(message.words.every(word => word.width > 0 && word.height > 0 && word.x >= 0 && word.y >= 0
        && word.x + word.width <= 1.000001 && word.y + word.height <= 1.000001))
      console.log(`Packaged OCR verified (${process.platform}/${process.arch}): ${message.text}`)
    } finally {
      await worker?.terminate()
      rmSync(modelDir, { recursive: true, force: true })
    }
  })().catch(error => { console.error(error); process.exitCode = 1 })
}
