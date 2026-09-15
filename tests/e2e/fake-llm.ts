import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

export type FakeLlmMode = 'normal' | 'slow' | '401' | '429' | 'refuse'

export interface ReceivedRequest {
  body: {
    model?: string
    messages?: { role: string; content: string }[]
    stream?: boolean
  }
  headers: {
    contentType: string | undefined
    authorization: string | undefined
  }
  path: string | undefined
}

export interface FakeLlm {
  url: string
  requests: ReceivedRequest[]
  setMode(mode: FakeLlmMode): void
  close(): Promise<void>
}

const active = new Set<FakeLlm>()

function json(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

/** A deterministic local OpenAI-compatible stream; authorization is always redacted in records. */
export async function startFakeLlm(): Promise<FakeLlm> {
  const requests: ReceivedRequest[] = []
  const sockets = new Set<import('node:net').Socket>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let mode: FakeLlmMode = 'normal'
  let server: Server

  const onRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      json(res, 404, { error: { message: 'not found' } })
      return
    }
    const raw = await readBody(req)
    let body: ReceivedRequest['body'] = {}
    try { body = JSON.parse(raw) as ReceivedRequest['body'] } catch { /* client gets a deterministic error below */ }
    requests.push({
      body,
      path: req.url,
      headers: {
        contentType: typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : undefined,
        authorization: req.headers.authorization ? 'Bearer ***' : undefined
      }
    })

    if (mode === 'refuse') {
      req.socket.destroy()
      return
    }
    if (mode === '401') {
      json(res, 401, { error: { message: 'invalid api key' } })
      return
    }
    if (mode === '429') {
      json(res, 429, { error: { message: 'rate limited' } })
      return
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    const answer = '这是假的回答。'
    const delay = mode === 'slow' ? 180 : 12
    let index = 0
    const writeNext = (): void => {
      if (index >= answer.length) {
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      const char = answer[index++]
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: char } }] })}\n\n`)
      const timer = setTimeout(() => {
        timers.delete(timer)
        writeNext()
      }, delay)
      timers.add(timer)
    }
    writeNext()
  }

  server = createServer((req, res) => { void onRequest(req, res) })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fake LLM did not bind a TCP port')

  const fake: FakeLlm = {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    setMode(next) { mode = next },
    async close() {
      active.delete(fake)
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    }
  }
  active.add(fake)
  return fake
}

export async function closeAllFakeLlms(): Promise<void> {
  const servers = [...active]
  await Promise.all(servers.map((server) => server.close().catch(() => {})))
}
