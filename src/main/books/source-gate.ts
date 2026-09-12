import { resolve } from 'node:path'

/**
 * 渲染层是沙箱化的不可信输入源(威胁模型:渲染层被攻破,而非恶意人类用户)。
 * stageImport / scanFolder 会把路径喂给文件系统操作,所以只能接受主进程
 * 自己交给渲染层的路径(系统对话框选出来的那些),不能信渲染层自己报的字符串。
 * 这个模块就是那道闸门:谁被 allowSource 记过名,谁才能通过 assertAllowed。
 *
 * 拖拽导入是后续任务,它的路径合法地来自渲染层本身,天然过不了这道闸门——
 * 那个任务需要自己单独一条更窄的通道,不应该复用这里的逻辑。
 */

const allowed = new Set<string>()

export function allowSource(path: string): void {
  allowed.add(resolve(path))
}

export function allowSources(paths: string[]): void {
  for (const p of paths) allowSource(p)
}

export function assertAllowed(path: string): string {
  const resolved = resolve(path)
  if (!allowed.has(resolved)) {
    throw new Error('未经用户选择的路径:' + path)
  }
  return resolved
}

export function assertEpub(path: string): void {
  if (!path.toLowerCase().endsWith('.epub')) {
    throw new Error('只支持 EPUB 文件:' + path)
  }
}

/** 仅供测试使用:清空已记录的路径,避免测试用例之间互相污染。 */
export function clearAllowedSources(): void {
  allowed.clear()
}
