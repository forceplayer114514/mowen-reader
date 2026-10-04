import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createBackup, installRestore, prepareRestore } from '../../src/main/backup'
import { openDatabase } from '../../src/main/db'
import { getBook, insertBook } from '../../src/main/db/books'
import { getPdfOcr, getPdfPosition, savePdfOcr, savePdfPosition } from '../../src/main/db/pdf-ocr'
import { booksDir, coversDir, dbFile } from '../../src/main/paths'

it('OCR stable IDs, word boxes and PDF viewport survive a verified backup and restore', async () => {
  const original = process.env.READER_USER_DATA
  const root = mkdtempSync(join(tmpdir(), 'mowen-ocr-backup-'))
  let db: ReturnType<typeof openDatabase> | null = null
  try {
    const source = join(root, 'source'), target = join(root, 'target'), backup = join(root, 'backup')
    for (const path of [source, target, backup]) mkdirSync(path)
    process.env.READER_USER_DATA = source
    const id = randomUUID(), path = join(booksDir(), `${id}.pdf`)
    coversDir()
    writeFileSync(path, 'PDF fixture bytes')
    db = openDatabase(dbFile())
    insertBook(db, { id, title: '扫描书', author: null, coverPath: null, filePath: path, sourcePath: '',
      addedAt: 1, lastReadCfi: 'epubcfi(/6/68[pdf-page-34]!/4:0)', lastReadAt: 2 })
    const result = savePdfOcr(db, 'full:eng', { bookId: id, page: 34, language: 'eng', region: null,
      text: 'Reading text', words: [{ text: 'Reading', x: .2, y: .3, width: .1, height: .02 }] })
    const position = { page: 34, x: .4, y: .7 }
    savePdfPosition(db, id, position)
    const folder = await createBackup(backup, db)
    db.close(); db = null
    process.env.READER_USER_DATA = target
    const stage = await prepareRestore(folder)
    await installRestore(stage)
    db = openDatabase(dbFile())
    expect(getPdfOcr(db, id, 34)).toEqual([result])
    expect(getPdfPosition(db, id)).toEqual(position)
    expect(getBook(db, id)?.filePath).toBe(join(target, 'books', `${id}.pdf`))
  } finally {
    db?.close()
    if (original === undefined) delete process.env.READER_USER_DATA
    else process.env.READER_USER_DATA = original
    rmSync(root, { recursive: true, force: true })
  }
})
