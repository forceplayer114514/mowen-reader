import { lstat } from 'node:fs/promises'
import type { ImportedFile } from '../../shared/types'
import { copyBookIntoLibrary } from './import'
import { assertAllowed, assertSupportedBook } from './source-gate'

/**
 * 校验单个路径已经在白名单里、且是支持的书籍格式后,再复制进库。
 * 文件选择器/文件夹扫描(先 allowSource 再走这里)与拖拽导入(先自己
 * allowSource 再走这里)最终都落到这一个函数上,校验逻辑只写一份,
 * 不会出现两条入口各自实现、慢慢跑偏的情况。
 *
 * 同样出于这个原因,符号链接/目录/非常规文件的拒绝也写在这里:
 * 白名单只看文件扩展名,copyBookIntoLibrary 用的 fs.copyFile 会跟随
 * 符号链接——一个叫 a.epub 的符号链接可以指向磁盘上任意文件,链接会被
 * 判定为"合法的书籍",真实字节被复制进库、读出内容。用 lstat(不跟随
 * 链接本身)挡在复制之前,两条入口都过这一道检查。
 */
export async function stageOne(sourcePath: string): Promise<ImportedFile> {
  const resolved = assertAllowed(sourcePath)
  assertSupportedBook(resolved)
  const fileStat = await lstat(resolved)
  if (fileStat.isSymbolicLink()) {
    throw new Error('不接受符号链接:' + resolved)
  }
  if (fileStat.isDirectory()) {
    throw new Error('不支持文件夹,请选择书籍文件:' + resolved)
  }
  if (!fileStat.isFile()) {
    throw new Error('不是常规文件:' + resolved)
  }
  return copyBookIntoLibrary(resolved)
}

/** 按输入顺序依次 stageOne;某一项失败会中断后续项,与原来的实现保持一致。 */
export async function stageMany(sourcePaths: string[]): Promise<ImportedFile[]> {
  const out: ImportedFile[] = []
  for (const p of sourcePaths) {
    out.push(await stageOne(p))
  }
  return out
}
