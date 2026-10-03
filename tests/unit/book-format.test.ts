import { describe, expect, it } from 'vitest'
import { bookFormat, supportedBookExtensions } from '../../src/shared/book-format'

describe('bookFormat', () => {
  it('识别 epub/pdf/txt,大小写不敏感', () => {
    expect(bookFormat('/a/b.epub')).toBe('epub')
    expect(bookFormat('/a/b.EPUB')).toBe('epub')
    expect(bookFormat('/a/b.pdf')).toBe('pdf')
    expect(bookFormat('/a/b.PDF')).toBe('pdf')
    expect(bookFormat('/a/b.txt')).toBe('txt')
    expect(bookFormat('/a/b.TXT')).toBe('txt')
  })

  it('不支持的扩展名返回 null', () => {
    expect(bookFormat('/a/b.mobi')).toBeNull()
    expect(bookFormat('/a/b.exe')).toBeNull()
    expect(bookFormat('/a/id_rsa')).toBeNull()
    expect(bookFormat('/a/b')).toBeNull()
    expect(bookFormat('/a/b.')).toBeNull()
  })

  it('多段扩展名按最后一段判定', () => {
    expect(bookFormat('/a/book.epub.txt')).toBe('txt')
    expect(bookFormat('/a/book.txt.pdf')).toBe('pdf')
  })

  it('白名单包含三类扩展名', () => {
    expect([...supportedBookExtensions].sort()).toEqual(['epub', 'pdf', 'txt'])
  })

})
