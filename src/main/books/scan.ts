import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

async function walk(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walk(full, out)
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.epub')) {
      out.push(full)
    }
  }
}

/** 递归找出文件夹下所有 EPUB,排除掉已经导入过的源路径。 */
export async function scanFolder(dir: string, alreadyImported: string[]): Promise<string[]> {
  let info: any
  try {
    info = await stat(dir)
  } catch {
    throw new Error(`找不到文件夹:${dir}`)
  }
  if (!info.isDirectory()) {
    throw new Error(`不是文件夹:${dir}`)
  }
  const found: string[] = []
  await walk(dir, found)
  const skip = new Set(alreadyImported)
  return found.filter((p) => !skip.has(p)).sort()
}
