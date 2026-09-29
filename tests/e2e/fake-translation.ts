import { createServer, type Server } from 'node:http'
const servers: Server[] = []

export async function startFakeTranslation() {
  const texts: string[] = []
  let mode: 'ok' | 'quota' | 'slow' = 'ok'
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost')
    texts.push(url.searchParams.get('q') ?? '')
    const send = () => {
      response.setHeader('Content-Type', 'application/json')
      if (url.pathname === '/jsonapi') {
        response.end(JSON.stringify({ ec: { word: [{ usphone: 'ˈtest', trs: [{ tr: [{ l: { i: ['n. 这是独立翻译结果。'] } }] }] }] } }))
        return
      }
      response.end(JSON.stringify(mode === 'quota'
        ? { responseStatus: 429, quotaFinished: true, responseDetails: 'Limit reached' }
        : { responseStatus: 200, responseData: { translatedText: '这是独立翻译结果。' } }))
    }
    if (mode === 'slow') setTimeout(send, 1500)
    else send()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  const address = server.address() as { port: number }
  return { url: `http://127.0.0.1:${address.port}`, texts,
    setMode: (next: typeof mode) => { mode = next } }
}

export async function closeFakeTranslations(): Promise<void> {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
