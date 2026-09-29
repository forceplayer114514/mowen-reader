import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createBackup, installRestore, prepareRestore } from '../../src/main/backup'
import { openDatabase } from '../../src/main/db'
import { insertBook, getBook } from '../../src/main/db/books'
import { booksDir, coversDir, dbFile } from '../../src/main/paths'

const originalData = process.env.READER_USER_DATA
const dirs: string[] = []
afterEach(() => {
  if (originalData === undefined) delete process.env.READER_USER_DATA
  else process.env.READER_USER_DATA = originalData
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

it('backs up live WAL data, verifies bytes and restores books with new local paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mowen-backup-test-'))
  dirs.push(root)
  const oldData = join(root, 'old')
  const newData = join(root, 'new')
  const syncFolder = join(root, 'cloud')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(oldData)
  mkdirSync(newData)
  mkdirSync(syncFolder)
  process.env.READER_USER_DATA = oldData
  const id = randomUUID()
  const book = join(booksDir(), `${id}.epub`)
  const cover = join(coversDir(), `${id}.png`)
  writeFileSync(book, 'book bytes')
  writeFileSync(cover, 'cover bytes')
  const db = openDatabase(dbFile())
  insertBook(db, { id, title: '备份书', author: null, filePath: book, coverPath: cover,
    sourcePath: '/old/source.epub', addedAt: 1, lastReadCfi: 'epubcfi(/6/2)', lastReadAt: 2 })
  db.prepare('INSERT INTO settings VALUES (?,?)').run('theme', 'dark')
  const backupDir = await createBackup(syncFolder, db)
  db.close()
  expect(existsSync(join(backupDir, 'reader.db'))).toBe(true)
  expect(readFileSync(join(backupDir, 'books', `${id}.epub`), 'utf8')).toBe('book bytes')
  // Restore on macOS from a Windows-authored database: the stored absolute paths are not portable.
  const archived = openDatabase(join(backupDir, 'reader.db'))
  archived.prepare('UPDATE books SET file_path = ?, cover_path = ? WHERE id = ?').run(
    `C:\\Users\\reader\\books\\${id}.epub`, `C:\\Users\\reader\\covers\\${id}.png`, id)
  archived.close()
  const manifestPath = join(backupDir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { files: { path: string; bytes: number; sha256: string }[] }
  const dbBytes = readFileSync(join(backupDir, 'reader.db'))
  const dbEntry = manifest.files.find((file) => file.path === 'reader.db')!
  dbEntry.bytes = dbBytes.length
  dbEntry.sha256 = createHash('sha256').update(dbBytes).digest('hex')
  writeFileSync(manifestPath, JSON.stringify(manifest))
  process.env.READER_USER_DATA = newData
  const current = openDatabase(dbFile())
  current.prepare('INSERT INTO settings VALUES (?,?)').run('theme', 'light')
  current.close()
  const stage = await prepareRestore(backupDir)
  const previous = await installRestore(stage)
  const restored = openDatabase(dbFile())
  expect(getBook(restored, id)).toMatchObject({ title: '备份书', filePath: join(newData, 'books', `${id}.epub`),
    coverPath: join(newData, 'covers', `${id}.png`), sourcePath: '' })
  expect(readFileSync(getBook(restored, id)!.filePath, 'utf8')).toBe('book bytes')
  expect(restored.prepare('SELECT value FROM settings WHERE key = ?').get('theme')).toMatchObject({ value: 'dark' })
  restored.close()
  expect(existsSync(join(previous, 'reader.db'))).toBe(true)
})

it('rejects changed backup bytes before replacing the current library', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mowen-backup-tamper-'))
  dirs.push(root)
  const data = join(root, 'data')
  const syncFolder = join(root, 'cloud')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(data)
  mkdirSync(syncFolder)
  process.env.READER_USER_DATA = data
  const db = openDatabase(dbFile())
  const backupDir = await createBackup(syncFolder, db)
  db.close()
  writeFileSync(join(backupDir, 'reader.db'), 'corrupt')
  await expect(prepareRestore(backupDir)).rejects.toThrow('损坏')
  expect(existsSync(dbFile())).toBe(true)
})

it('rolls back the original library when installing a staged restore fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mowen-restore-rollback-'))
  dirs.push(root)
  process.env.READER_USER_DATA = root
  const originalDb = dbFile()
  const originalBook = join(booksDir(), 'original.epub')
  coversDir()
  writeFileSync(originalDb, 'original database')
  writeFileSync(originalBook, 'original book')
  const brokenStage = join(root, '.broken-stage')
  mkdirSync(brokenStage)
  mkdirSync(join(brokenStage, 'books'))
  writeFileSync(join(brokenStage, 'reader.db'), 'new database')
  await expect(installRestore(brokenStage)).rejects.toThrow()
  expect(readFileSync(originalDb, 'utf8')).toBe('original database')
  expect(readFileSync(originalBook, 'utf8')).toBe('original book')
  expect(existsSync(coversDir())).toBe(true)
})
