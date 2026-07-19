import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { extractDocument, MAX_UPLOAD_BYTES } from './documentIntake'

async function minimalDocx(text: string) {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`)
  return Buffer.from(await zip.generateAsync({ type: 'uint8array' }))
}

function minimalPdf(text: string) {
  const escaped = text.replace(/([()\\])/g, '\\$1')
  const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(pdf)
}

describe('document intake', () => {
  it('extracts bounded plain text without persisting an upload', async () => {
    const result = await extractDocument({
      filename: 'decision.txt',
      contentType: 'text/plain; charset=utf-8',
      body: Buffer.from('We should acquire the company because retention improved by 20%.\nThe valuation assumes growth continues.'),
    })

    expect(result).toMatchObject({ filename: 'decision.txt', mediaType: 'text/plain' })
    expect(result.text).toContain('retention improved')
  })

  it('accepts markdown sent as plain text by a browser', async () => {
    const result = await extractDocument({ filename: 'plan.md', contentType: 'text/plain', body: Buffer.from('# Plan\nWe should launch next month.') })
    expect(result.mediaType).toBe('text/plain')
  })

  it('extracts real DOCX and text-based PDF content', async () => {
    const docx = await extractDocument({
      filename: 'appeal.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      body: await minimalDocx('The cited contract clause must be tested.'),
    })
    const pdf = await extractDocument({
      filename: 'memo.pdf',
      contentType: 'application/pdf',
      body: minimalPdf('The investment thesis needs evidence.'),
    })

    expect(docx.text).toContain('contract clause')
    expect(pdf).toMatchObject({ pageCount: 1 })
    expect(pdf.text).toContain('investment thesis')
  })

  it('rejects unsupported, empty, mismatched, and oversized uploads', async () => {
    await expect(extractDocument({ filename: 'sheet.csv', contentType: 'text/csv', body: Buffer.from('a,b') })).rejects.toThrow(/Supported file types/)
    await expect(extractDocument({ filename: 'empty.txt', contentType: 'text/plain', body: Buffer.alloc(0) })).rejects.toThrow(/empty/)
    await expect(extractDocument({ filename: 'wrong.pdf', contentType: 'text/plain', body: Buffer.from('not pdf') })).rejects.toThrow(/do not match/)
    await expect(extractDocument({ filename: 'large.txt', contentType: 'text/plain', body: Buffer.alloc(MAX_UPLOAD_BYTES + 1) })).rejects.toThrow(/8 MB/)
  })
})
