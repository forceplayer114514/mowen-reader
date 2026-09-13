import { randomUUID } from 'node:crypto'

export interface ChatSession {
  id: string
  signal: AbortSignal
}

/**
 * 登记同时在跑的模型请求,让渲染层能按 id 中止其中某一个。
 * id 在这里生成而不是由渲染层传入——与"库内路径由主进程派生"同一条原则。
 */
export function createSessionRegistry(): {
  start(): ChatSession
  abort(id: string): void
  abortAll(): void
  finish(id: string): void
  size(): number
} {
  const live = new Map<string, AbortController>()

  return {
    start(): ChatSession {
      const id = randomUUID()
      const controller = new AbortController()
      live.set(id, controller)
      return { id, signal: controller.signal }
    },
    abort(id: string): void {
      live.get(id)?.abort()
      live.delete(id)
    },
    abortAll(): void {
      for (const controller of live.values()) controller.abort()
      live.clear()
    },
    finish(id: string): void {
      live.delete(id)
    },
    size(): number {
      return live.size
    }
  }
}
