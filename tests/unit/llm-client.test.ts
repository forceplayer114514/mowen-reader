import { describe, expect, it, vi } from 'vitest'
import { streamChat } from '../../src/main/llm/client'

function sseResponse(texts: string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder()
      for (const t of texts) {
        controller.enqueue(
          enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`)
        )
      }
      controller.enqueue(enc.encode('data: [DONE]\n\n'))
      controller.close()
    }
  })
  return new Response(body, { status })
}

function base(over: Partial<Parameters<typeof streamChat>[0]> = {}) {
  return {
    endpoint: 'https://example.invalid/v1',
    model: 'test-model',
    apiKey: 'sk-test',
    messages: [{ role: 'user', content: '你好' }],
    signal: new AbortController().signal,
    onChunk: () => {},
    ...over
  }
}

describe('流式请求', () => {
  it('把收到的文字块按顺序交给回调', async () => {
    const got: string[] = []
    await streamChat(
      base({
        onChunk: (t) => got.push(t),
        fetchImpl: async () => sseResponse(['你', '好', '吗'])
      })
    )
    expect(got).toEqual(['你', '好', '吗'])
  })

  it('请求发到 endpoint 下的 chat/completions,带上 Bearer 密钥和模型名', async () => {
    const spy = vi.fn(async () => sseResponse(['x']))
    await streamChat(base({ fetchImpl: spy as unknown as typeof fetch }))
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://example.invalid/v1/chat/completions')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
    const sent = JSON.parse(init.body as string) as { model: string; stream: boolean }
    expect(sent.model).toBe('test-model')
    expect(sent.stream).toBe(true)
  })

  it('endpoint 末尾有没有斜杠都不影响拼出的地址', async () => {
    const spy = vi.fn(async () => sseResponse(['x']))
    await streamChat(
      base({ endpoint: 'https://example.invalid/v1/', fetchImpl: spy as unknown as typeof fetch })
    )
    expect((spy.mock.calls[0] as unknown as [string])[0]).toBe(
      'https://example.invalid/v1/chat/completions'
    )
  })

  it('密钥不出现在抛出的错误信息里', async () => {
    const fetchImpl = async () => new Response('{"error":{"message":"bad key"}}', { status: 401 })
    await expect(streamChat(base({ fetchImpl: fetchImpl as unknown as typeof fetch })))
      .rejects.toThrow(/密钥/)
    await streamChat(base({ fetchImpl: fetchImpl as unknown as typeof fetch })).catch((e: Error) => {
      expect(e.message).not.toContain('sk-test')
    })
  })

  it('代理把请求头回显进错误体时,密钥和 Bearer 前缀都不会露出去', async () => {
    const echoed =
      '{"error":{"message":"Blocked request with headers: Authorization=Bearer sk-supersecret-12345"}}'
    const fetchImpl = async () => new Response(echoed, { status: 403 })
    await streamChat(base({ apiKey: 'sk-supersecret-12345', fetchImpl: fetchImpl as unknown as typeof fetch })).catch(
      (e: Error) => {
        expect(e.message).not.toContain('sk-supersecret-12345')
        expect(e.message).not.toContain('Bearer sk-')
      }
    )
  })

  it('代理回显的是另一个凭证(不是本次用的密钥)时也要被打码', async () => {
    const echoed = '{"error":{"message":"upstream saw Bearer some-other-token-999"}}'
    const fetchImpl = async () => new Response(echoed, { status: 403 })
    await streamChat(base({ apiKey: 'sk-test', fetchImpl: fetchImpl as unknown as typeof fetch })).catch(
      (e: Error) => {
        expect(e.message).not.toContain('some-other-token-999')
        expect(e.message).not.toContain('Bearer s')
      }
    )
  })

  it('正常的错误体不受打码逻辑影响,原样通过', async () => {
    const fetchImpl = async () => new Response('{"error":{"message":"model not found"}}', { status: 404 })
    await streamChat(base({ fetchImpl: fetchImpl as unknown as typeof fetch })).catch((e: Error) => {
      expect(e.message).toContain('model not found')
    })
  })

  it('HTTP 错误被翻译成中文抛出', async () => {
    await expect(
      streamChat(
        base({
          fetchImpl: (async () => new Response('', { status: 429 })) as unknown as typeof fetch
        })
      )
    ).rejects.toThrow(/额度|频繁/)
  })

  it('网络层抛错也被翻译成中文', async () => {
    const boom = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    await expect(
      streamChat(
        base({
          fetchImpl: (async () => {
            throw boom
          }) as unknown as typeof fetch
        })
      )
    ).rejects.toThrow(/连不上|地址/)
  })

  it('连接一直不回应时到期并显示中文超时提示', async () => {
    const fetchImpl = (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    await expect(
      streamChat(base({ fetchImpl: fetchImpl as typeof fetch, timeoutMs: 5 }))
    ).rejects.toThrow(/请求超时/)
  })

  it('用户中止时正常结束,不抛错', async () => {
    const ac = new AbortController()
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' })
    ac.abort()
    await expect(
      streamChat(
        base({
          signal: ac.signal,
          fetchImpl: (async () => {
            throw err
          }) as unknown as typeof fetch
        })
      )
    ).resolves.toBeUndefined()
  })

  it('中止后不再继续交付文字块', async () => {
    const ac = new AbortController()
    const got: string[] = []
    // 两个事件挤在同一个网络分片里一次性送达,在 onChunk 里拿到第一个之后才
    // 中止——这样才是真正测到"送到一半中止,剩下的不再送"这件事本身;
    // 如果在 start() 里提前 abort,读循环第一次检查就会直接跳出,一个块都
    // 没送过,断言就成立得毫无意义。
    const fetchImpl = async (): Promise<Response> => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder()
          const chunk =
            `data: ${JSON.stringify({ choices: [{ delta: { content: '第一块' } }] })}\n\n` +
            `data: ${JSON.stringify({ choices: [{ delta: { content: '第二块' } }] })}\n\n`
          controller.enqueue(enc.encode(chunk))
          controller.close()
        }
      })
      return new Response(body, { status: 200 })
    }
    await streamChat(
      base({
        signal: ac.signal,
        onChunk: (t) => {
          got.push(t)
          if (t === '第一块') ac.abort()
        },
        fetchImpl: fetchImpl as unknown as typeof fetch
      })
    )
    expect(got).toContain('第一块')
    expect(got).not.toContain('第二块')
  })

  it('URL 拼接:朴素的 base 地址', async () => {
    const spy = vi.fn(async () => sseResponse(['x']))
    await streamChat(
      base({ endpoint: 'https://example.invalid/v1', fetchImpl: spy as unknown as typeof fetch })
    )
    expect((spy.mock.calls[0] as unknown as [string])[0]).toBe(
      'https://example.invalid/v1/chat/completions'
    )
  })

  it('URL 拼接:base 已经以 /chat/completions 结尾,不重复拼接', async () => {
    const spy = vi.fn(async () => sseResponse(['x']))
    await streamChat(
      base({
        endpoint: 'https://example.invalid/v1/chat/completions',
        fetchImpl: spy as unknown as typeof fetch
      })
    )
    expect((spy.mock.calls[0] as unknown as [string])[0]).toBe(
      'https://example.invalid/v1/chat/completions'
    )
  })

  it('URL 拼接:带查询串的 Azure 风格地址,路径追加而不破坏查询串', async () => {
    const spy = vi.fn(async () => sseResponse(['x']))
    await streamChat(
      base({
        endpoint: 'https://example.invalid/openai/deployments/x?api-version=2024-05-01',
        fetchImpl: spy as unknown as typeof fetch
      })
    )
    expect((spy.mock.calls[0] as unknown as [string])[0]).toBe(
      'https://example.invalid/openai/deployments/x/chat/completions?api-version=2024-05-01'
    )
  })

  it('URL 拼接:解析不了的地址不会崩溃,退化成中文错误', async () => {
    const fetchImpl = async (): Promise<Response> => {
      throw new TypeError('Failed to parse URL')
    }
    await expect(
      streamChat(
        base({
          endpoint: 'not a url at all',
          fetchImpl: fetchImpl as unknown as typeof fetch
        })
      )
    ).rejects.toThrow(/请检查网络与接口地址/)
  })

  it('onChunk 抛出的异常不会被误判成网络问题,原始信息保留', async () => {
    const cancel = vi.fn(async () => undefined)
    const fetchImpl = async (): Promise<Response> => {
      // 流特意不关闭:如果流已经 close 了,reader.cancel() 在一个已关闭的流
      // 上不会触发下面这个 cancel 回调,就测不出"reader 真的被释放了"这件事。
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder()
          controller.enqueue(
            enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: '你' } }] })}\n\n`)
          )
        },
        cancel
      })
      return new Response(body, { status: 200 })
    }
    await expect(
      streamChat(
        base({
          onChunk: () => {
            throw new Error('BUG')
          },
          fetchImpl: fetchImpl as unknown as typeof fetch
        })
      )
    ).rejects.toThrow(/BUG/)
    await expect(
      streamChat(
        base({
          onChunk: () => {
            throw new Error('BUG')
          },
          fetchImpl: fetchImpl as unknown as typeof fetch
        })
      )
    ).rejects.not.toThrow(/请检查网络与接口地址/)
    expect(cancel).toHaveBeenCalled()
  })

  it('响应没有 body 时报出中文错误', async () => {
    await expect(
      streamChat(
        base({
          fetchImpl: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch
        })
      )
    ).rejects.toThrow(/没有返回/)
  })
})
