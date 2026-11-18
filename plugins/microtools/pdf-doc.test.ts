/**
 * Tests for the PDF interception helpers.
 *
 * Fixtures are built inline: the minimal PDF is assembled byte by byte with a
 * real text layer, and its base64 form is produced here too. Nothing binary is
 * committed and no network access happens.
 */

import { describe, expect, test } from "bun:test"
import {
  DEFAULT_PDF_CHAR_LIMIT,
  DEFAULT_PDF_SIZE_LIMIT_BYTES,
  buildEnvelope,
  createPdfHandler,
  decodeBase64ToBytes,
  detectPdfPart,
  type CompletedToolEvent,
} from "./pdf-doc.ts"

/** Assemble a minimal one-page PDF whose page draws one text line. */
function buildMinimalPdf(text: string): Uint8Array {
  const stream = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  let pdf = "%PDF-1.4\n"
  const offsets: number[] = []
  objects.forEach((body, index) => {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xrefOffset = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return new TextEncoder().encode(pdf)
}

function pdfPart(base64: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "file", mime: "application/pdf", content: base64, name: "doc.pdf", ...extra }
}

function readEvent(content: unknown, extra: Partial<CompletedToolEvent> = {}): CompletedToolEvent {
  return { tool: "read", status: "completed", result: { content }, ...extra }
}

describe("decodeBase64ToBytes", () => {
  test("decodes base64 into bytes", () => {
    const bytes = decodeBase64ToBytes("aGVsbG8=")
    expect(new TextDecoder().decode(bytes)).toBe("hello")
  })
})

describe("detectPdfPart", () => {
  test("detects a PDF file part", () => {
    const content = [pdfPart("AAAA")]
    const found = detectPdfPart(content)
    expect(found.status).toBe("pdf")
    if (found.status === "pdf") {
      expect(found.index).toBe(0)
      expect(found.part.content).toBe("AAAA")
    }
  })

  test("ignores non-PDF content", () => {
    expect(detectPdfPart([{ type: "text", text: "hi" }]).status).toBe("none")
    expect(detectPdfPart([{ type: "file", mime: "image/png", content: "AAAA" }]).status).toBe("none")
    expect(detectPdfPart("plain string").status).toBe("none")
  })

  test("flags a PDF-like part whose content shape does not match", () => {
    const found = detectPdfPart([pdfPart(42 as unknown as string)])
    expect(found.status).toBe("invalid")
  })

  test("detects by case-insensitive mime", () => {
    const found = detectPdfPart([pdfPart("AAAA", { mime: "Application/PDF" })])
    expect(found.status).toBe("pdf")
  })
})

describe("buildEnvelope", () => {
  test("builds a text-layer envelope", () => {
    const envelope = buildEnvelope({ file: "doc.pdf", pages: 3, text: "Some content." })
    expect(envelope).toMatchObject({
      kind: "document",
      file: "doc.pdf",
      mime: "application/pdf",
      pages: 3,
      textLayer: true,
      chars: 13,
      truncated: false,
    })
    expect(envelope.text).toBe("Some content.")
    expect(envelope.note).toContain("replaced")
  })

  test("marks an empty text layer as scanned with an OCR note", () => {
    const envelope = buildEnvelope({ file: "scan.pdf", pages: 1, text: "   \n  " })
    expect(envelope.textLayer).toBe(false)
    expect(envelope.chars).toBe(0)
    expect(envelope.note.toLowerCase()).toContain("ocr")
  })

  test("truncates oversized text explicitly", () => {
    const envelope = buildEnvelope({ file: "big.pdf", pages: 9, text: "x".repeat(200), charLimit: 50 })
    expect(envelope.truncated).toBe(true)
    expect(envelope.chars).toBe(50)
    expect(envelope.text).toBe("x".repeat(50))
    expect(envelope.note.toLowerCase()).toContain("truncat")
  })
})

describe("createPdfHandler", () => {
  test("replaces a real PDF part with the extraction envelope", async () => {
    const sentence = "Hello from the microtools PDF fixture."
    const base64 = Buffer.from(buildMinimalPdf(sentence)).toString("base64")
    const event = readEvent([pdfPart(base64)])
    const debug: unknown[] = []

    const converted = await createPdfHandler({ onDebug: (entry) => debug.push(entry) })(event)

    expect(converted).toBe(true)
    expect(debug).toEqual([])
    const content = event.result?.content as Array<Record<string, unknown>>
    expect(content).toHaveLength(1)
    expect(content[0].type).toBe("text")
    const envelope = JSON.parse(content[0].text as string)
    expect(envelope.kind).toBe("document")
    expect(envelope.file).toBe("doc.pdf")
    expect(envelope.pages).toBe(1)
    expect(envelope.textLayer).toBe(true)
    expect(envelope.truncated).toBe(false)
    expect(envelope.text).toContain(sentence)
  })

  test("leaves the original result untouched on extraction failure", async () => {
    const original = [pdfPart("not-valid-base64!!")]
    const event = readEvent(original)
    const converted = await createPdfHandler({})(event)
    expect(converted).toBe(false)
    expect(event.result?.content).toBe(original)
  })

  test("skips PDFs above the size limit without touching the result", async () => {
    const base64 = Buffer.from(buildMinimalPdf("small")).toString("base64")
    const original = [pdfPart(base64)]
    const event = readEvent(original)
    const debug: unknown[] = []
    const converted = await createPdfHandler({ sizeLimitBytes: 8, onDebug: (entry) => debug.push(entry) })(event)
    expect(converted).toBe(false)
    expect(event.result?.content).toBe(original)
    expect(debug.length).toBeGreaterThan(0)
  })

  test("ignores non-read tools and non-completed events", async () => {
    const base64 = Buffer.from(buildMinimalPdf("irrelevant")).toString("base64")
    expect(await createPdfHandler({})(readEvent([pdfPart(base64)], { tool: "bash" }))).toBe(false)
    expect(await createPdfHandler({})(readEvent([pdfPart(base64)], { status: "error" }))).toBe(false)
    expect(await createPdfHandler({})({ tool: "read", status: "completed" })).toBe(false)
  })

  test("extraction beyond the char limit truncates, not skips", async () => {
    const base64 = Buffer.from(buildMinimalPdf("abcdefghij")).toString("base64")
    const event = readEvent([pdfPart(base64)])
    const converted = await createPdfHandler({ charLimit: 5 })(event)
    expect(converted).toBe(true)
    const envelope = JSON.parse((event.result?.content as Array<Record<string, unknown>>)[0].text as string)
    expect(envelope.truncated).toBe(true)
    expect(envelope.chars).toBeLessThanOrEqual(5)
  })

  test("defaults are bounded and sane", () => {
    expect(DEFAULT_PDF_CHAR_LIMIT).toBe(100_000)
    expect(DEFAULT_PDF_SIZE_LIMIT_BYTES).toBeLessThanOrEqual(21 * 1024 * 1024)
  })
})
