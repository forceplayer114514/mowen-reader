import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { decodeText, textToEpub } from '../../src/renderer/reader/text-book'

function utf8(text: string): ArrayBuffer { return new TextEncoder().encode(text).buffer as ArrayBuffer }

describe('TXT books', () => {
  it('handles UTF-8/BOM/UTF-16/GB18030 and normalizes line endings', () => {
    expect(decodeText(utf8('\ufeff第一章\r\n你好'))).toBe('第一章\n你好')
    expect(decodeText(Uint8Array.from([0xff, 0xfe, 0x60, 0x4f, 0x7d, 0x59]).buffer)).toBe('你好')
    expect(decodeText(Uint8Array.from([0xfe, 0xff, 0x4f, 0x60, 0x59, 0x7d]).buffer)).toBe('你好')
    expect(decodeText(Uint8Array.from([0xc4, 0xe3, 0xba, 0xc3]).buffer)).toBe('你好')
  })
  it('rejects empty and binary files', () => {
    expect(() => decodeText(utf8(' \n'))).toThrow(/没有可阅读/)
    expect(() => decodeText(utf8('hello\u0000world'))).toThrow(/二进制/)
  })
  it('escapes markup and creates deterministic chapter paths and paragraph DOM', async () => {
    const data = utf8('第一章 开始\n<script>alert("x")</script>\n第二章 结束\n你好 & 再见')
    const first = await JSZip.loadAsync(await textToEpub(data, '书<名>'))
    const second = await JSZip.loadAsync(await textToEpub(data, '书<名>'))
    expect(await first.file('mimetype')!.async('string')).toBe('application/epub+zip')
    const chapter = await first.file('ch0.xhtml')!.async('string')
    expect(chapter).toContain('&lt;script&gt;')
    expect(chapter).not.toContain('<script>')
    expect(await first.file('nav.xhtml')!.async('string')).toContain('第二章 结束')
    expect(await first.file('ch1.xhtml')!.async('string')).toContain('你好 &amp; 再见')
    expect(chapter).toBe(await second.file('ch0.xhtml')!.async('string'))
  })
})
