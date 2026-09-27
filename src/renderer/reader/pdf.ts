import { getDocument, GlobalWorkerOptions, type PDFDocumentLoadingTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'

GlobalWorkerOptions.workerSrc = workerUrl

/** PDF resources are bundled locally: opening a book never fetches a CDN. */
export function loadPdf(data: ArrayBuffer): PDFDocumentLoadingTask {
  const resources = new URL('./pdf-assets/', window.location.href).href
  return getDocument({
    data: new Uint8Array(data.slice(0)),
    cMapUrl: `${resources}cmaps/`, cMapPacked: true,
    standardFontDataUrl: `${resources}standard_fonts/`, wasmUrl: `${resources}wasm/`,
    enableXfa: false
  })
}

export function pdfError(error: unknown): Error {
  if (error instanceof Error && error.name === 'PasswordException') {
    return new Error('此 PDF 需要密码，请先用 PDF 软件解除密码后导入')
  }
  return new Error(`PDF 无法解析，请检查文件是否完整：${error instanceof Error ? error.message : String(error)}`)
}
