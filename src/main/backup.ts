import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import type { Db } from './db'
import { SCHEMA_VERSION, openDatabase } from './db'
import { booksDir, coversDir, resolveDataDir } from './paths'

interface BackupFile { path: string; bytes: number; sha256: string }
interface Manifest { format: 'mowen-backup'; version: 1; createdAt: string; files: BackupFile[] }

const BOOK_FILE = /^books\/[0-9a-f-]{36}\.(epub|pdf|txt)$/i
const COVER_FILE = /^covers\/[0-9a-f-]{36}\.(png|jpg|jpeg|gif|webp|bmp)$/i

interface BackupConfig { folder: string | null; lastBackup: string | null }

export class RestoreRollbackError extends Error {}

function configPath(): string { return join(resolveDataDir(), 'backup-location.json') }

export async function readBackupConfig(): Promise<BackupConfig> {
  try {
    const parsed = JSON.parse(await readFile(configPath(), 'utf8')) as BackupConfig
    return {
      folder: typeof parsed.folder === 'string' ? parsed.folder : null,
      lastBackup: typeof parsed.lastBackup === 'string' ? parsed.lastBackup : null
    }
  } catch { return { folder: null, lastBackup: null } }
}

export async function writeBackupConfig(config: BackupConfig): Promise<void> {
  await writeFile(configPath(), JSON.stringify(config))
}

function safeName(name: string): boolean {
  return name === 'reader.db' || BOOK_FILE.test(name) || COVER_FILE.test(name)
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function expectedName(path: string, id: string, kind: 'books' | 'covers'): string {
  const name = `${kind}/${basename(path)}`
  if (!safeName(name) || !basename(path).toLowerCase().startsWith(`${id.toLowerCase()}.`)) {
    throw new Error('书库中有无法安全备份的文件名')
  }
  const root = kind === 'books' ? booksDir() : coversDir()
  if (!resolve(path).startsWith(resolve(root) + sep)) throw new Error('书库文件位于应用目录之外，无法安全备份')
  return name
}

async function copyChecked(source: string, target: string): Promise<BackupFile> {
  const info = await lstat(source)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('书库中存在非普通文件，备份已停止')
  await mkdir(dirname(target), { recursive: true })
  await copyFile(source, target)
  return { path: '', bytes: (await stat(target)).size, sha256: await hashFile(target) }
}

/** 生成可直接放进 iCloud/OneDrive/Dropbox 同步目录的完整快照。 */
export async function createBackup(folder: string, db: Db): Promise<string> {
  const stage = await mkdtemp(join(folder, '.mowen-backup-'))
  try {
    const snapshot = join(stage, 'reader.db')
    await backup(db, snapshot)
    const files: BackupFile[] = [{ path: 'reader.db', bytes: (await stat(snapshot)).size, sha256: await hashFile(snapshot) }]
    const snapshotDb = new DatabaseSync(snapshot, { readOnly: true })
    let rows: { id: string; file_path: string; cover_path: string | null }[]
    try {
      rows = snapshotDb.prepare('SELECT id, file_path, cover_path FROM books').all() as typeof rows
    } finally { snapshotDb.close() }
    for (const row of rows) {
      for (const [kind, path] of [['books', row.file_path], ['covers', row.cover_path]] as const) {
        if (!path) continue
        const name = expectedName(path, row.id, kind)
        const meta = await copyChecked(path, join(stage, name))
        files.push({ ...meta, path: name })
      }
    }
    const manifest: Manifest = { format: 'mowen-backup', version: 1, createdAt: new Date().toISOString(), files }
    await writeFile(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2))
    const output = join(folder, `墨问备份-${manifest.createdAt.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`)
    await rename(stage, output)
    return output
  } catch (error) {
    await rm(stage, { recursive: true, force: true })
    throw error
  }
}

/** 校验后仅构建待恢复目录，不触碰现有书库；调用方随后负责切换并重启。 */
export async function prepareRestore(folder: string): Promise<string> {
  const source = resolve(folder)
  const manifestPath = join(source, 'manifest.json')
  const manifestInfo = await lstat(manifestPath)
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > 10_000_000) throw new Error('备份清单无效或过大')
  const raw = await readFile(manifestPath, 'utf8')
  const manifest = JSON.parse(raw) as Manifest
  if (manifest.format !== 'mowen-backup' || manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length > 100_000) {
    throw new Error('不是受支持的墨问备份')
  }
  const names = new Set<string>()
  for (const file of manifest.files) {
    if (!file || typeof file.path !== 'string' || !safeName(file.path) || names.has(file.path) ||
      !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error('备份清单包含无效文件')
    }
    names.add(file.path)
  }
  if (!names.has('reader.db')) throw new Error('备份缺少数据库')
  const stage = await mkdtemp(join(resolveDataDir(), '.mowen-restore-'))
  try {
    await mkdir(join(stage, 'books'))
    await mkdir(join(stage, 'covers'))
    for (const file of manifest.files) {
      const from = join(source, file.path)
      const info = await lstat(from)
      if (!info.isFile() || info.isSymbolicLink() || info.size !== file.bytes || await hashFile(from) !== file.sha256) {
        throw new Error(`备份文件损坏：${file.path}`)
      }
      await mkdir(dirname(join(stage, file.path)), { recursive: true })
      await copyFile(from, join(stage, file.path))
      if (await hashFile(join(stage, file.path)) !== file.sha256) throw new Error(`备份文件复制失败：${file.path}`)
    }
    const header = Buffer.alloc(16)
    const handle = await open(join(stage, 'reader.db'), 'r')
    try { await handle.read(header, 0, header.length, 0) } finally { await handle.close() }
    if (header.toString('utf8') !== 'SQLite format 3\0') throw new Error('备份数据库格式无效')
    const restored = openDatabase(join(stage, 'reader.db'))
    try {
      const integrity = restored.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
      if (integrity.integrity_check !== 'ok') throw new Error('备份数据库已损坏')
      if (restored.prepare('PRAGMA foreign_key_check').all().length > 0) throw new Error('备份数据库关联数据已损坏')
      const version = restored.prepare('PRAGMA user_version').get() as { user_version: number }
      if (version.user_version > SCHEMA_VERSION) throw new Error('备份来自更新版本的墨问')
      const rows = restored.prepare('SELECT id, file_path, cover_path FROM books').all() as { id: string; file_path: string; cover_path: string | null }[]
      const update = restored.prepare('UPDATE books SET file_path = ?, cover_path = ?, source_path = ? WHERE id = ?')
      for (const row of rows) {
        const book = expectedNameForRestore(row.file_path, row.id, 'books')
        const cover = row.cover_path ? expectedNameForRestore(row.cover_path, row.id, 'covers') : null
        if (!names.has(book) || (cover && !names.has(cover))) throw new Error('备份缺少书籍或封面文件')
        update.run(join(booksDir(), basename(book)), cover ? join(coversDir(), basename(cover)) : null, '', row.id)
      }
    } finally { restored.close() }
    return stage
  } catch (error) {
    await rm(stage, { recursive: true, force: true })
    throw error
  }
}

function expectedNameForRestore(path: string, id: string, kind: 'books' | 'covers'): string {
  // 数据库中的旧路径来自备份设备；Windows 与 macOS 路径分隔符都要识别。
  const base = path.replace(/\\/g, '/').split('/').at(-1) ?? ''
  const name = `${kind}/${base}`
  if (!safeName(name) || !base.toLowerCase().startsWith(`${id.toLowerCase()}.`)) throw new Error('备份数据库包含无效书籍路径')
  return name
}

/** 保留原数据在时间戳目录中，失败时尽量回滚；成功后由调用方重启应用。 */
export async function installRestore(stage: string): Promise<string> {
  const root = resolveDataDir()
  const previous = join(root, `恢复前数据-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  await mkdir(previous)
  const targets = ['reader.db', 'reader.db-wal', 'reader.db-shm', 'books', 'covers']
  const moved: string[] = []
  const installed: string[] = []
  try {
    for (const name of targets) {
      try { await rename(join(root, name), join(previous, name)); moved.push(name) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    for (const name of ['reader.db', 'books', 'covers']) {
      await rename(join(stage, name), join(root, name))
      installed.push(name)
    }
    await rm(stage, { recursive: true, force: true })
    return previous
  } catch (error) {
    const rollbackFailures: string[] = []
    for (const name of installed.reverse()) {
      try { await rename(join(root, name), join(stage, name)) } catch { rollbackFailures.push(name) }
    }
    for (const name of moved.reverse()) {
      try { await rename(join(previous, name), join(root, name)) } catch { rollbackFailures.push(name) }
    }
    if (rollbackFailures.length) throw new RestoreRollbackError(`自动回滚未完成（${rollbackFailures.join('、')}）。原数据保存在 ${previous}；请不要继续使用软件。`)
    throw error
  }
}
