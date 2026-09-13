import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ipc.ts 里的数据库句柄挂在模块作用域上、第一次用到时才打开,整个测试文件
// 共用同一份。import 会被提升到这行赋值之前执行,这里不需要"先于 import"——
// 数据目录是真正用到时才解析的,赶在第一次调用 handler 之前定下来就够了,
// 定下来之后不再更换。
process.env.READER_USER_DATA = mkdtempSync(join(tmpdir(), 'reader-ipc-'))

/**
 * 假的 electron:只截下 ipcMain.handle 注册的 handler,让测试能直接调用它们。
 * 必须用 vi.hoisted —— vi.mock 的工厂会被提升到所有 import 之前执行,
 * 普通的 const 那时还没初始化。
 */
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: never[]) => unknown>(),
  streamChat: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: never[]) => unknown): void => {
      mocks.handlers.set(channel, fn)
    }
  },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
}))

vi.mock('../../src/main/llm/client', () => ({
  streamChat: (options: unknown) => mocks.streamChat(options)
}))

import { registerIpc } from '../../src/main/ipc'
import { __setSafeStorageForTests, clearApiKey, setApiKey } from '../../src/main/secrets'

/** 可逆的字节反转冒充加密,和 secrets 的单元测试用的是同一个假实现。 */
const fakeSafeStorage = {
  isEncryptionAvailable: (): boolean => true,
  encryptString: (s: string): Buffer => Buffer.from(Buffer.from(s, 'utf8').reverse()),
  decryptString: (b: Buffer): string => Buffer.from(Buffer.from(b).reverse()).toString('utf8')
}

registerIpc()

type Listener = (...args: unknown[]) => void

/** 假的 WebContents:记下发出去的事件,并能手动触发生命周期事件。 */
function fakeSender(): {
  sent: { channel: string; args: unknown[] }[]
  fire(event: string, ...args: unknown[]): void
} & Record<string, unknown> {
  const sent: { channel: string; args: unknown[] }[] = []
  const listeners = new Map<string, Set<Listener>>()
  const wrappers = new Map<Listener, Listener>()
  const bucket = (event: string): Set<Listener> => {
    let set = listeners.get(event)
    if (!set) {
      set = new Set()
      listeners.set(event, set)
    }
    return set
  }
  return {
    sent,
    isDestroyed: (): boolean => false,
    send: (channel: string, ...args: unknown[]): void => {
      sent.push({ channel, args })
    },
    on: (event: string, listener: Listener): void => {
      bucket(event).add(listener)
    },
    once: (event: string, listener: Listener): void => {
      const wrapper = (...args: unknown[]): void => {
        bucket(event).delete(wrapper)
        listener(...args)
      }
      wrappers.set(listener, wrapper)
      bucket(event).add(wrapper)
    },
    off: (event: string, listener: Listener): void => {
      const set = bucket(event)
      set.delete(listener)
      const wrapper = wrappers.get(listener)
      if (wrapper) set.delete(wrapper)
    },
    fire: (event: string, ...args: unknown[]): void => {
      for (const listener of [...bucket(event)]) listener(...args)
    }
  }
}

function call(channel: string, sender: unknown, ...args: unknown[]): unknown {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`没有注册这个通道:${channel}`)
  return handler({ sender } as unknown, ...(args as never[]))
}

/** 把宏任务队列推进一轮,让 chat:start 里 setImmediate 排的请求真正发出去。 */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

beforeEach(() => {
  __setSafeStorageForTests(fakeSafeStorage)
  clearApiKey()
  mocks.streamChat.mockReset()
  mocks.streamChat.mockResolvedValue(undefined)
  call('settings:set', null, 'llmEndpoint', 'https://api.openai.com/v1')
  call('settings:set', null, 'llmModel', 'gpt-4o-mini')
})

describe('settings:set 只接受白名单里的键', () => {
  it('白名单里的键正常写入', () => {
    call('settings:set', null, 'llmModel', 'gpt-4o')
    expect(call('settings:get', null, 'llmModel')).toBe('gpt-4o')
  })

  it('名单外的键被拒绝,值也没写进去', () => {
    expect(() => call('settings:set', null, '随便什么键', '值')).toThrow(/随便什么键/)
    expect(call('settings:get', null, '随便什么键')).toBeNull()
  })
})

describe('secrets:setApiKey 把密钥绑到当时的接口地址上', () => {
  it('没填接口地址时不让存密钥', () => {
    call('settings:set', null, 'llmEndpoint', '')
    expect(() => call('secrets:setApiKey', null, 'sk-x')).toThrow(/接口地址/)
  })

  it('接口地址不安全时不让存密钥', () => {
    call('settings:set', null, 'llmEndpoint', 'http://api.example.com/v1')
    expect(() => call('secrets:setApiKey', null, 'sk-x')).toThrow(/http/)
  })

  it('不是字符串的密钥被当场拒绝,不会被写进文件', () => {
    // 写进去的话,下次读出来整段信封会被当成密钥、地址为空,报的却是
    // "这是旧版本存下的",把排查引向完全错误的方向。
    call('settings:set', null, 'llmEndpoint', 'https://api.openai.com/v1')
    expect(() => call('secrets:setApiKey', null, 42)).toThrow(/必须是一段文字/)
    expect(call('secrets:hasApiKey', null)).toBe(false)
  })

  it('清除密钥不需要接口地址', () => {
    call('settings:set', null, 'llmEndpoint', '')
    expect(() => call('secrets:setApiKey', null, '')).not.toThrow()
  })
})

describe('chat:start 在取密钥之前先核对接口地址', () => {
  it('地址没变时正常发起请求,密钥进的是请求参数而不是返回值', async () => {
    call('secrets:setApiKey', null, 'sk-真的密钥')
    const sender = fakeSender()
    const id = await call('chat:start', sender, { messages: [{ role: 'user', content: '你好' }] })
    expect(typeof id).toBe('string')
    await flush()
    expect(mocks.streamChat).toHaveBeenCalledTimes(1)
    const options = mocks.streamChat.mock.calls[0][0] as { apiKey: string; endpoint: string }
    expect(options.apiKey).toBe('sk-真的密钥')
    expect(options.endpoint).toBe('https://api.openai.com/v1')
    expect(JSON.stringify(id)).not.toContain('sk-真的密钥')
  })

  it('渲染层偷偷把地址改成别人家的,密钥不会被发出去', async () => {
    call('secrets:setApiKey', null, 'sk-真的密钥')
    // 被攻破的渲染层能做的就是这一步:地址仍然是 https,协议校验拦不住它
    call('settings:set', null, 'llmEndpoint', 'https://evil.example/v1')
    const sender = fakeSender()
    await expect(
      call('chat:start', sender, { messages: [] }) as Promise<string>
    ).rejects.toThrow(/evil\.example/)
    await flush()
    expect(mocks.streamChat).not.toHaveBeenCalled()
  })

  it('只改了端口也拦下来', async () => {
    call('settings:set', null, 'llmEndpoint', 'http://127.0.0.1:1234/v1')
    call('secrets:setApiKey', null, 'sk-本地')
    call('settings:set', null, 'llmEndpoint', 'http://127.0.0.1:11434/v1')
    await expect(
      call('chat:start', fakeSender(), { messages: [] }) as Promise<string>
    ).rejects.toThrow(/重新填写/)
    await flush()
    expect(mocks.streamChat).not.toHaveBeenCalled()
  })

  it('旧版本存下的、没有记录地址的密钥,要求重新填写而不是直接发出去', async () => {
    setApiKey('sk-老版本存的')
    await expect(
      call('chat:start', fakeSender(), { messages: [] }) as Promise<string>
    ).rejects.toThrow(/重新填写/)
    await flush()
    expect(mocks.streamChat).not.toHaveBeenCalled()
  })
})

describe('页面刷新之后不再往它发对话事件', () => {
  it('刷新过的页面收不到这次请求的 chat:done 和 chat:chunk', async () => {
    call('secrets:setApiKey', null, 'sk-真的密钥')
    let release = (): void => {}
    let capturedOnChunk: (text: string) => void = () => {}
    mocks.streamChat.mockImplementation((options: { onChunk: (t: string) => void }) => {
      capturedOnChunk = options.onChunk
      return new Promise<void>((resolve) => {
        release = resolve
      })
    })

    const sender = fakeSender()
    await call('chat:start', sender, { messages: [] })
    await flush()
    expect(mocks.streamChat).toHaveBeenCalledTimes(1)

    // 用户刷新了整个页面:WebContents 没被销毁,isDestroyed() 仍然是 false。
    // 事件形状按 Electron 现在支持的来:标志在第一个 details 对象上。
    sender.fire('did-start-navigation', { isMainFrame: true }, 'app://reload', false)

    // 中止之后才到达的文字块和收尾,都不该越过页面边界
    capturedOnChunk('迟到的文字')
    release()
    await flush()
    await flush()

    expect(sender.sent).toEqual([])
  })

  it('用户自己点停止时,chat:done 照样送得出去', async () => {
    // 封口开关只该在生命周期中止(页面真的走了)时按死。用户点停止走的是
    // chat:abort,页面还在等这条收尾——把它一起封掉的话,气泡会永远停在
    // "正在输入"上。
    call('secrets:setApiKey', null, 'sk-真的密钥')
    let release = (): void => {}
    mocks.streamChat.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )

    const sender = fakeSender()
    const id = await call('chat:start', sender, { messages: [] })
    await flush()

    call('chat:abort', null, id)
    release()
    await flush()
    await flush()

    expect(sender.sent.map((s) => s.channel)).toEqual(['chat:done'])
    expect(sender.sent[0].args[1]).toEqual({ status: 'stopped' })
  })

  it('同文档导航(# 片段跳转之类)不中止请求,也不封口', async () => {
    // 页面根本没换过,React 还在,请求 id 还攥在渲染层手里。当成"页面已经
    // 走了"会两头落空:请求被中止,而收尾又被封掉,界面永远等不到结果。
    call('secrets:setApiKey', null, 'sk-真的密钥')
    let release = (): void => {}
    mocks.streamChat.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )

    const sender = fakeSender()
    await call('chat:start', sender, { messages: [] })
    await flush()

    sender.fire(
      'did-start-navigation',
      { isMainFrame: true, isSameDocument: true },
      'app://index#settings',
      true
    )

    release()
    await flush()
    await flush()

    expect(sender.sent.map((s) => s.channel)).toEqual(['chat:done'])
    expect(sender.sent[0].args[1]).toEqual({ status: 'finished' })
  })

  it('页面没刷新时 chat:done 照常送达', async () => {
    call('secrets:setApiKey', null, 'sk-真的密钥')
    const sender = fakeSender()
    await call('chat:start', sender, { messages: [] })
    await flush()
    await flush()
    expect(sender.sent.map((s) => s.channel)).toEqual(['chat:done'])
    expect(sender.sent[0].args[1]).toEqual({ status: 'finished' })
  })
})
