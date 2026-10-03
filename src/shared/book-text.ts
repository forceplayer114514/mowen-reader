/** UTF-8 first; recognize UTF-16 BOM, and fall back to common Chinese GB18030 TXT. */
export function decodeText(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data)
  let text: string
  if (bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder('utf-16le', { fatal: true }).decode(bytes)
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder('utf-16be', { fatal: true }).decode(bytes)
  else {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    catch { text = new TextDecoder('gb18030', { fatal: true }).decode(bytes) }
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(text)) throw new Error('TXT 包含二进制内容，无法导入')
  text = text.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n').trim()
  if (!text) throw new Error('TXT 文件没有可阅读的文字')
  return text
}
