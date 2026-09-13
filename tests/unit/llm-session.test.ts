import { describe, expect, it, vi } from 'vitest'
import { bindSessionLifecycle, createSessionRegistry } from '../../src/main/llm/session'
import type { LifecycleTarget } from '../../src/main/llm/session'

describe('请求会话登记', () => {
  it('开始一个请求会拿到唯一 id', () => {
    const reg = createSessionRegistry()
    const a = reg.start()
    const b = reg.start()
    expect(a.id).not.toBe(b.id)
  })

  it('新开的请求没有被中止', () => {
    const reg = createSessionRegistry()
    expect(reg.start().signal.aborted).toBe(false)
  })

  it('按 id 中止会让对应的信号变为已中止', () => {
    const reg = createSessionRegistry()
    const s = reg.start()
    reg.abort(s.id)
    expect(s.signal.aborted).toBe(true)
  })

  it('中止一个请求不影响另一个', () => {
    const reg = createSessionRegistry()
    const a = reg.start()
    const b = reg.start()
    reg.abort(a.id)
    expect(b.signal.aborted).toBe(false)
  })

  it('中止不存在的 id 不报错', () => {
    const reg = createSessionRegistry()
    expect(() => reg.abort('没有这个')).not.toThrow()
  })

  it('结束后再中止同一个 id 不报错', () => {
    const reg = createSessionRegistry()
    const s = reg.start()
    reg.finish(s.id)
    expect(() => reg.abort(s.id)).not.toThrow()
  })

  it('结束会把请求从登记表里移除', () => {
    const reg = createSessionRegistry()
    const s = reg.start()
    expect(reg.size()).toBe(1)
    reg.finish(s.id)
    expect(reg.size()).toBe(0)
  })

  it('abortAll 中止全部并清空登记表', () => {
    const reg = createSessionRegistry()
    const a = reg.start()
    const b = reg.start()
    reg.abortAll()
    expect(a.signal.aborted).toBe(true)
    expect(b.signal.aborted).toBe(true)
    expect(reg.size()).toBe(0)
  })
})

type Listener = (...args: unknown[]) => void

/**
 * 一个最小的、行为像 EventEmitter 的假 WebContents:只实现 bindSessionLifecycle
 * 用得到的 on/once/off,再加一个 fire() 方便测试代码手动触发事件——不依赖
 * Electron,纯内存对象。
 *
 * once 必须是真的 once:事件一触发就摘掉监听器,不管回调自己做不做事。
 * 这个区别正是下面那条回归测试要抓的东西——如果这里把 once 实现成"加进去
 * 就不再摘",子 frame 导航吃掉监听器的那个 bug 在假对象上根本不会重现。
 */
function fakeWebContents(): LifecycleTarget & {
  fire(event: 'destroyed'): void
  fire(event: 'did-start-navigation', isMainFrame: boolean): void
  listenerCount(event: string): number
} {
  const listeners = new Map<string, Set<Listener>>()
  const onceWrappers = new Map<Listener, Listener>()
  const get = (event: string): Set<Listener> => {
    let set = listeners.get(event)
    if (!set) {
      set = new Set()
      listeners.set(event, set)
    }
    return set
  }
  return {
    on: (event: string, listener: Listener): void => {
      get(event).add(listener)
    },
    once: (event: string, listener: Listener): void => {
      const wrapper = (...args: unknown[]): void => {
        get(event).delete(wrapper)
        listener(...args)
      }
      onceWrappers.set(listener, wrapper)
      get(event).add(wrapper)
    },
    off: (event: string, listener: Listener): void => {
      const set = get(event)
      set.delete(listener)
      const wrapper = onceWrappers.get(listener)
      if (wrapper) set.delete(wrapper)
    },
    fire: (event: string, isMainFrame?: boolean): void => {
      for (const listener of [...get(event)]) {
        listener(undefined, 'https://example.invalid', false, isMainFrame)
      }
    },
    listenerCount: (event: string): number => get(event).size
  } as LifecycleTarget & {
    fire(event: 'destroyed'): void
    fire(event: 'did-start-navigation', isMainFrame: boolean): void
    listenerCount(event: string): number
  }
}

describe('请求生命周期绑定到 WebContents', () => {
  it('WebContents 被销毁时中止请求', () => {
    const target = fakeWebContents()
    const abort = vi.fn()
    bindSessionLifecycle(target, abort)
    target.fire('destroyed')
    expect(abort).toHaveBeenCalledTimes(1)
  })

  it('主 frame 开始导航(含刷新)时中止请求', () => {
    const target = fakeWebContents()
    const abort = vi.fn()
    bindSessionLifecycle(target, abort)
    target.fire('did-start-navigation', true)
    expect(abort).toHaveBeenCalledTimes(1)
  })

  it('子 frame(比如 EPUB 翻页用的 iframe)导航不会误杀正在进行的请求', () => {
    const target = fakeWebContents()
    const abort = vi.fn()
    bindSessionLifecycle(target, abort)
    target.fire('did-start-navigation', false)
    expect(abort).not.toHaveBeenCalled()
  })

  it('dispose 之后,窗口销毁或导航都不再触发中止', () => {
    const target = fakeWebContents()
    const abort = vi.fn()
    const dispose = bindSessionLifecycle(target, abort)
    dispose()
    target.fire('destroyed')
    target.fire('did-start-navigation', true)
    expect(abort).not.toHaveBeenCalled()
  })

  it('请求正常结束时 dispose 不会误触发 abort 本身', () => {
    const target = fakeWebContents()
    const abort = vi.fn()
    const dispose = bindSessionLifecycle(target, abort)
    dispose()
    expect(abort).not.toHaveBeenCalled()
  })

  it('假 WebContents 的 once 确实是一次性的(否则下面那条回归测试形同虚设)', () => {
    const target = fakeWebContents()
    const seen = vi.fn()
    target.once('destroyed', seen)
    target.fire('destroyed')
    target.fire('destroyed')
    expect(seen).toHaveBeenCalledTimes(1)
    expect(target.listenerCount('destroyed')).toBe(0)
  })

  it('翻过章节(子 frame 导航)之后再刷新,请求仍然被中止', () => {
    // 回归:导航监听器如果用 once 注册,子 frame 的那次导航就把它消耗掉了——
    // 回调不动手不代表监听器还在。epub.js 用 iframe 渲染章节,用户每换一章
    // 就消耗一次,之后的刷新就再也中止不了正在跑的请求。
    const target = fakeWebContents()
    const abort = vi.fn()
    bindSessionLifecycle(target, abort)
    target.fire('did-start-navigation', false)
    expect(abort).not.toHaveBeenCalled()
    target.fire('did-start-navigation', true)
    expect(abort).toHaveBeenCalledTimes(1)
  })

  it('连翻多章之后刷新,照样中止', () => {
    const target = fakeWebContents()
    const abort = vi.fn()
    bindSessionLifecycle(target, abort)
    for (let i = 0; i < 5; i += 1) target.fire('did-start-navigation', false)
    target.fire('did-start-navigation', true)
    expect(abort).toHaveBeenCalledTimes(1)
  })

  it('dispose 之后导航监听器真的被摘掉,不会越积越多', () => {
    const target = fakeWebContents()
    const dispose = bindSessionLifecycle(target, vi.fn())
    expect(target.listenerCount('did-start-navigation')).toBe(1)
    dispose()
    expect(target.listenerCount('did-start-navigation')).toBe(0)
    expect(target.listenerCount('destroyed')).toBe(0)
  })
})
