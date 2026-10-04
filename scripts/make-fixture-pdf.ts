import { deflateSync } from 'node:zlib'

/** Small, deterministic three-page PDF exercising text, outline and a real raster-only page. */
export function buildFixturePdf(): Buffer {
  const stream = (content: string, entries = ''): string => `<< ${entries} /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`
  const pixels = Buffer.alloc(300 * 400 * 3, 255)
  for (let y = 125; y < 275; y++) pixels.fill(Buffer.from([51, 128, 178]), (y * 300 + 40) * 3, (y * 300 + 260) * 3)
  const image = `${deflateSync(pixels).toString('hex')}>`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /Outlines 10 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 6 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 6 0 R >> >> /Contents 8 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /XObject << /Im1 14 0 R >> >> /Contents 9 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    stream('BT /F1 24 Tf 60 700 Td (PDF Reading Test) Tj 0 -50 Td /F1 16 Tf (First page text for translation and notes.) Tj ET'),
    stream('BT /F1 24 Tf 60 700 Td (Second chapter) Tj 0 -50 Td /F1 16 Tf (Second page restores bookmarks and conversations.) Tj ET'),
    stream('q 600 0 0 800 0 0 cm /Im1 Do Q'),
    '<< /Type /Outlines /First 11 0 R /Last 12 0 R /Count 2 >>',
    '<< /Title (Start) /Parent 10 0 R /Next 12 0 R /Dest [3 0 R /Fit] >>',
    '<< /Title (Second chapter) /Parent 10 0 R /Prev 11 0 R /Dest [4 0 R /Fit] >>',
    '<< /Title (PDF Reading Test) /Author (Mowen Tests) >>',
    stream(image, '/Type /XObject /Subtype /Image /Width 300 /Height 400 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter [/ASCIIHexDecode /FlateDecode]')
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 13 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf)
}
