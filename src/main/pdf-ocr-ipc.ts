import { join } from 'node:path'
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { PdfOcrInput, PdfPosition } from '../shared/pdf-ocr-types'
import type { Db } from './db'
import { getPdfOcr, getPdfPosition, savePdfPosition } from './db/pdf-ocr'
import { resolveDataDir } from './paths'
import { normalizePdfPosition, PdfOcrService, validatePdfBook, validatePdfPage } from './pdf-ocr'

let service: PdfOcrService | null = null
function assertReader(event: IpcMainInvokeEvent): void {
  const expected = new URL(process.env.ELECTRON_RENDERER_URL || new URL('../renderer/index.html', import.meta.url).href).href
  if (event.senderFrame !== event.sender.mainFrame || event.sender.mainFrame.url !== expected) throw new Error('阅读窗口无效')
}
export function registerPdfOcrIpc(database: () => Db): void {
  service = new PdfOcrService({ database, workerPath: join(import.meta.dirname, 'pdf-ocr-worker.js'),
    modelDir: join(resolveDataDir(), 'ocr-models') })
  const watched = new Set<number>()
  ipcMain.handle('pdf:ocr', (event, input: PdfOcrInput) => {
    assertReader(event)
    if (!watched.has(event.sender.id)) {
      watched.add(event.sender.id)
      event.sender.once('destroyed', () => { watched.delete(event.sender.id); void service?.cancelOwner(event.sender.id) })
      event.sender.on('render-process-gone', () => { void service?.cancelOwner(event.sender.id) })
      event.sender.on('did-start-navigation', (_e, _url, _inPlace, mainFrame) => { if (mainFrame) void service?.cancelOwner(event.sender.id) })
    }
    return service!.recognize(input, event.sender.id, progress => {
      if (!event.sender.isDestroyed()) event.sender.send('pdf:ocrProgress', progress)
    })
  })
  ipcMain.handle('pdf:cancelOcr', (event, requestId: string) => { assertReader(event); return service!.cancel(requestId, event.sender.id) })
  ipcMain.handle('pdf:getOcr', (event, bookId: string, page: number) => {
    assertReader(event); validatePdfBook(database(), bookId); validatePdfPage(page)
    return getPdfOcr(database(), bookId, page)
  })
  ipcMain.handle('pdf:getPosition', (event, bookId: string) => {
    assertReader(event); validatePdfBook(database(), bookId)
    return getPdfPosition(database(), bookId)
  })
  ipcMain.handle('pdf:savePosition', (event, bookId: string, position: PdfPosition) => {
    assertReader(event); validatePdfBook(database(), bookId)
    savePdfPosition(database(), bookId, normalizePdfPosition(position))
  })
}
export function disposePdfOcr(): void { service?.dispose() }
