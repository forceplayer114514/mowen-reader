import { randomUUID } from 'node:crypto'

export interface ChatSession {
  id: string
  signal: AbortSignal
}

/**
 * 一个请求发起方(WebContents)最小需要满足的形状——只列用得到的几个方法,
 * 不直接依赖 electron 的类型,这样这个文件可以在没有 Electron 运行时的
 * 单元测试里被直接测试。真正的 Electron WebContents 结构上满足这个接口,
 * 传进来不需要做任何适配。
 *
 * 'did-start-navigation' 的监听器特意接住 isMainFrame 这个参数:EPUB 阅读
 * 页面本身很可能用 iframe 渲染章节内容,翻页会不断触发子 frame 的导航事件——
 * 如果不分主子 frame 一律中止,正在进行的对话会在用户翻页的瞬间被误杀。
 * 只有主 frame 的导航(用户重新加载或跳转了整个应用页面)才代表"这个请求
 * 已经没有界面能再收到结果了"。
 */
export interface LifecycleTarget {
  once(event: 'destroyed', listener: () => void): unknown
  once(
    event: 'did-start-navigation',
    listener: (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void
  ): unknown
  off(event: 'destroyed', listener: () => void): unknown
  off(
    event: 'did-start-navigation',
    listener: (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void
  ): unknown
}

/**
 * 把一次模型请求的生命周期绑定到发起它的 WebContents 上。
 *
 * 背景:`event.sender.send()` 本身只发给发起请求的那个 WebContents,不会
 * 广播,这一点没问题。但两种情况下请求会"活得比发起它的窗口还久":
 * 1) `webContents.reload()` 不会销毁 WebContents,刷新后的新页面会收到一个
 *    它从未发起过的请求的后续 chunk 和 done。
 * 2) macOS 上关掉最后一个窗口会销毁 WebContents,但不会中止请求——
 *    `isDestroyed()` 只是让 send() 变成空操作,fetch 本身仍在跑,socket
 *    仍然开着,token 仍在计费,而且已经没有任何界面持有这个请求的 id,
 *    `chat:abort` 再也没有人能调用它了。
 *
 * 这个函数订阅 WebContents 的 'destroyed' 和 'did-start-navigation'(仅主
 * frame)事件,两者任一触发都调用 abort() 中止会话。返回一个 dispose
 * 函数——请求正常结束(无论成功、失败还是被主动中止)时必须调用它解绑这两个
 * 监听器,否则一个长期开着、反复对话的窗口会不断积累永远不会再触发的监听器。
 */
export function bindSessionLifecycle(target: LifecycleTarget, abort: () => void): () => void {
  const onDestroyed = (): void => abort()
  const onNavigate = (
    _event: unknown,
    _url: string,
    _isInPlace: boolean,
    isMainFrame: boolean
  ): void => {
    if (isMainFrame) abort()
  }

  target.once('destroyed', onDestroyed)
  target.once('did-start-navigation', onNavigate)

  return (): void => {
    target.off('destroyed', onDestroyed)
    target.off('did-start-navigation', onNavigate)
  }
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
