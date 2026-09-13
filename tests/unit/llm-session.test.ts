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

/**
 * 一个最小的、行为像 EventEmitter 的假 WebContents:只实现 bindSessionLifecycle
 * 用得到的 once/off,再加一个 fire() 方便测试代码手动触发事件——不依赖
 * Electron,纯内存对象。
 */
function fakeWebContents(): LifecycleTarget & {
  fire(event: 'destroyed'): void
  fire(event: 'did-start-navigation', isMainFrame: boolean): void
} {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const get = (event: string): Set<(...args: unknown[]) => void> => {
    let set = listeners.get(event)
    if (!set) {
      set = new Set()
      listeners.set(event, set)
    }
    return set
  }
  return {
    once: (event: string, listener: (...args: unknown[]) => void): void => {
      get(event).add(listener)
    },
    off: (event: string, listener: (...args: unknown[]) => void): void => {
      get(event).delete(listener)
    },
    fire: (event: string, isMainFrame?: boolean): void => {
      for (const listener of get(event)) {
        listener(undefined, 'https://example.invalid', false, isMainFrame)
      }
    }
  } as LifecycleTarget & {
    fire(event: 'destroyed'): void
    fire(event: 'did-start-navigation', isMainFrame: boolean): void
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
})
