import type { ImportedFile } from '../../shared/types'
import { copyEpubIntoLibrary } from './import'
import { assertAllowed, assertEpub } from './source-gate'

/**
 * 校验单个路径已经在白名单里、且是 EPUB 后缀,再复制进库。
 * 文件选择器/文件夹扫描(先 allowSource 再走这里)与拖拽导入(先自己
 * allowSource 再走这里)最终都落到这一个函数上,校验逻辑只写一份,
 * 不会出现两条入口各自实现、慢慢跑偏的情况。
 */
export async function stageOne(sourcePath: string): Promise<ImportedFile> {
  const resolved = assertAllowed(sourcePath)
  assertEpub(resolved)
  return copyEpubIntoLibrary(resolved)
}

/** 按输入顺序依次 stageOne;某一项失败会中断后续项,与原来的实现保持一致。 */
export async function stageMany(sourcePaths: string[]): Promise<ImportedFile[]> {
  const out: ImportedFile[] = []
  for (const p of sourcePaths) {
    out.push(await stageOne(p))
  }
  return out
}
