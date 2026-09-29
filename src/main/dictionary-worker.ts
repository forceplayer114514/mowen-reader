import { createReadStream } from 'node:fs'
import { parentPort, workerData } from 'node:worker_threads'
import { StringDecoder } from 'node:string_decoder'
import { DatabaseSync } from 'node:sqlite'

// ECDICT's quoted CSV contains commas and may contain newlines. Import once;
// lookups then use SQLite's primary-key index instead of scanning 66 MB each time.
const { csv, database } = workerData as { csv: string; database: string }
const db = new DatabaseSync(database)
try {
  db.exec('CREATE TABLE entries (word TEXT PRIMARY KEY COLLATE NOCASE, phonetic TEXT, translation TEXT)')
  const insert = db.prepare('INSERT OR REPLACE INTO entries VALUES (?, ?, ?)')
  db.exec('BEGIN')
  let row: string[] = []
  let field = ''
  let quoted = false
  let quotePending = false
  let header = true
  let count = 0
  const finish = (): void => {
    row.push(field)
    if (header) header = false
    else if (row[0] && row[3]) { insert.run(row[0], row[1] ?? '', row[3]); count++ }
    row = []
    field = ''
  }
  const consume = (text: string): void => {
    for (const char of text) {
      if (quotePending) {
        quotePending = false
        if (char === '"') { field += '"'; continue }
        quoted = false
      }
      if (quoted) {
        if (char === '"') quotePending = true
        else field += char
      } else if (char === '"' && field === '') quoted = true
      else if (char === ',') { row.push(field); field = '' }
      else if (char === '\n') finish()
      else if (char !== '\r') field += char
    }
  }
  const decoder = new StringDecoder('utf8')
  for await (const chunk of createReadStream(csv)) consume(decoder.write(chunk as Buffer))
  consume(decoder.end())
  if (quotePending) { quoted = false; quotePending = false }
  if (field || row.length) finish()
  if (quoted || count < 1) throw new Error('词库 CSV 无效')
  db.exec('COMMIT')
  parentPort?.postMessage({ ok: true, count })
} catch (error) {
  try { db.exec('ROLLBACK') } catch { /* transaction may not have started */ }
  parentPort?.postMessage({ ok: false, message: error instanceof Error ? error.message : '词库导入失败' })
} finally {
  db.close()
}
