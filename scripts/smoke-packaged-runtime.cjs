// Run native inference through the actual packaged Electron, including ASAR unpacking.
const assert = require('node:assert/strict')
const { join, resolve } = require('node:path')
const { spawnSync } = require('node:child_process')
const { Worker } = require('node:worker_threads')

if (process.argv[2] !== '--inside') {
  const root = process.platform === 'darwin'
    ? resolve('release', process.arch === 'arm64' ? 'mac-arm64' : 'mac', '墨问.app', 'Contents')
    : resolve('release/win-unpacked')
  const executable = process.platform === 'darwin' ? join(root, 'MacOS/墨问') : join(root, '墨问.exe')
  const asar = join(root, process.platform === 'darwin' ? 'Resources' : 'resources', 'app.asar')
  const result = spawnSync(executable, [__filename, '--inside', asar], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 120_000
  })
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  assert.ifError(result.error)
  assert.equal(result.status, 0, 'Packaged native runtime smoke failed')
} else {
  const asar = process.argv[3]
  assert.ok(process.env.READER_OFFLINE_SMOKE_PATH, 'A verified offline model is required')
  const worker = new Worker(join(asar, 'out/main/translation-worker.js'))
  let replied = false
  const timer = setTimeout(() => { worker.terminate(); throw new Error('Packaged inference timed out') }, 90_000)
  worker.once('error', error => { clearTimeout(timer); throw error })
  worker.once('exit', code => {
    if (!replied) { clearTimeout(timer); assert.fail(`Packaged worker exited before replying (${code})`) }
  })
  worker.once('message', message => {
    replied = true
    clearTimeout(timer)
    worker.terminate()
    assert.equal(message.ok, true, message.message)
    assert.match(message.text, /[\u3400-\u9fff]/)
    console.log(`Packaged offline translation verified (${process.platform}/${process.arch}): ${message.text}`)
  })
  worker.postMessage({ type: 'translate', modelDir: process.env.READER_OFFLINE_SMOKE_PATH,
    text: 'The reader opened the book and began to read.' })
}
