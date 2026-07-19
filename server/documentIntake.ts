import * as mammoth from 'mammoth'

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024
export const MAX_EXTRACTED_CHARACTERS = 200_000

export type ExtractedDocument = {
  filename: string
  mediaType: string
  text: string
  pageCount?: number
  warnings: string[]
}

const MEDIA_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
])

function safeFilename(value: string) {
  const decoded = decodeURIComponent(value).split(/[\\/]/).pop()?.trim() ?? ''
  if (!decoded || decoded.length > 180 || /[\u0000-\u001f\u007f]/.test(decoded)) throw new Error('A valid filename is required.')
  return decoded
}

function normalizedMediaType(value: string) {
  return value.split(';')[0].trim().toLowerCase()
}

function mediaTypeFromExtension(filename: string) {
  const extension = filename.toLowerCase().split('.').pop()
  if (extension === 'txt') return 'text/plain'
  if (extension === 'md' || extension === 'markdown') return 'text/markdown'
  if (extension === 'pdf') return 'application/pdf'
  if (extension === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  return undefined
}

function cleanExtractedText(value: string) {
  return value.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim()
}

function boundedText(value: string) {
  const text = cleanExtractedText(value)
  if (!text) throw new Error('No readable text was found. Scanned or image-only documents need OCR before upload.')
  if (text.length > MAX_EXTRACTED_CHARACTERS) throw new Error(`Extracted text exceeds the ${MAX_EXTRACTED_CHARACTERS.toLocaleString('en-US')} character review limit.`)
  return text
}

async function extractPdf(buffer: Buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true })
  try {
    const document = await loadingTask.promise
    if (document.numPages > 250) throw new Error('PDF exceeds the 250-page extraction limit.')
    const pages: string[] = []
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      const text = content.items
        .map((item) => typeof item === 'object' && item !== null && 'str' in item && typeof item.str === 'string' ? item.str : '')
        .filter(Boolean)
        .join(' ')
      pages.push(text)
      page.cleanup()
    }
    return { text: pages.join('\n\n'), pageCount: document.numPages }
  } catch (error) {
    if (error instanceof Error && /password/i.test(error.message)) throw new Error('Password-protected PDFs are not supported.')
    throw error
  } finally {
    await loadingTask.destroy()
  }
}

/**
 * Extracts text in memory. The original upload is never persisted and callers
 * must not log the body or extracted content.
 */
export async function extractDocument(input: { filename: string; contentType: string; body: Buffer }): Promise<ExtractedDocument> {
  const filename = safeFilename(input.filename)
  if (!Buffer.isBuffer(input.body)) throw new Error('The uploaded document body is missing.')
  if (input.body.length === 0) throw new Error('The uploaded document is empty.')
  if (input.body.length > MAX_UPLOAD_BYTES) throw new Error('The uploaded document exceeds the 8 MB limit.')

  const declaredType = normalizedMediaType(input.contentType)
  const extensionType = mediaTypeFromExtension(filename)
  const mediaType = MEDIA_TYPES.has(declaredType) ? declaredType : extensionType
  if (!mediaType || !MEDIA_TYPES.has(mediaType)) throw new Error('Supported file types are TXT, Markdown, DOCX, and text-based PDF.')
  if (extensionType && declaredType && MEDIA_TYPES.has(declaredType) && extensionType !== declaredType
    && !(extensionType === 'text/markdown' && declaredType === 'text/plain')) {
    throw new Error('The filename and declared document type do not match.')
  }

  let text: string
  let pageCount: number | undefined
  const warnings: string[] = []
  if (mediaType === 'text/plain' || mediaType === 'text/markdown') {
    text = input.body.toString('utf8')
  } else if (mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const result = await mammoth.extractRawText({ buffer: input.body })
    text = result.value
    if (result.messages.length) warnings.push('Some document formatting was omitted during text extraction.')
  } else {
    const result = await extractPdf(input.body)
    text = result.text
    pageCount = result.pageCount
  }

  return {
    filename,
    mediaType,
    text: boundedText(text),
    ...(pageCount ? { pageCount } : {}),
    warnings,
  }
}

