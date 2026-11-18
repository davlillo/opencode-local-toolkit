/**
 * PDF interception for the `read` tool.
 *
 * The host returns PDFs as raw base64 file parts, which would flood the model
 * context with bytes it cannot use. This module replaces such a part with a
 * compact JSON envelope holding the extracted text layer. Any failure leaves
 * the original result exactly as the host produced it — never throws into the
 * host.
 */

import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { extractText } from "unpdf"
import type { CompletedToolEvent, ToolResultLike } from "./host-result.ts"

/** Maximum extracted characters handed to the model (explicit, never silent). */
export const DEFAULT_PDF_CHAR_LIMIT = 100_000

/** Skip PDFs whose base64 payload decodes above ~20 MiB: the host fails those anyway. */
export const DEFAULT_PDF_SIZE_LIMIT_BYTES = 20 * 1024 * 1024

/** Text below this trimmed length counts as "no text layer" (scanned PDF). */
const NEAR_EMPTY_CHARS = 8

const REPLACEMENT_NOTE =
  "The original PDF file part was replaced by this extracted text; re-read the file to view the raw PDF."
const OCR_NOTE =
  "No embedded text layer was found (likely a scanned PDF); OCR would be required to read its content."

export interface PdfEnvelope {
  kind: "document"
  file: string
  mime: "application/pdf"
  pages: number
  textLayer: boolean
  chars: number
  truncated: boolean
  note: string
  text: string
}

interface FilePart {
  type: string
  mime?: string
  content?: unknown
  name?: unknown
  uri?: unknown
}

export type Detection =
  | { status: "pdf"; part: FilePart; index: number }
  | { status: "invalid"; index: number }
  | { status: "none" }

/** Detect a PDF file part in a result content value. Pure and shape-strict. */
export function detectPdfPart(content: unknown): Detection {
  if (!Array.isArray(content)) return { status: "none" }
  for (let index = 0; index < content.length; index++) {
    const part = content[index] as FilePart | undefined
    if (!part || typeof part !== "object") continue
    if (part.type !== "file") continue
    if (typeof part.mime !== "string" || part.mime.toLowerCase() !== "application/pdf") continue
    if (typeof part.content === "string") return { status: "pdf", part, index }
    if (uriToLocalPath(part.uri) !== undefined) return { status: "pdf", part, index }
    if (dataUrlPayload(part.uri) !== undefined) return { status: "pdf", part, index }
    return { status: "invalid", index }
  }
  return { status: "none" }
}

/** Decode a base64 payload into bytes. Throws on invalid input. */
export function decodeBase64ToBytes(base64: string): Uint8Array {
  return Buffer.from(base64, "base64")
}

/** Extract the base64 payload of an application/pdf data URI, if present. */
export function dataUrlPayload(uri: unknown): string | undefined {
  if (typeof uri !== "string") return undefined
  const marker = "data:application/pdf;base64,"
  if (!uri.startsWith(marker)) return undefined
  const payload = uri.slice(marker.length)
  return payload.length > 0 ? payload : undefined
}

/** Resolve a tool-result URI to a local path when it points at this machine. */
export function uriToLocalPath(uri: unknown): string | undefined {
  if (typeof uri !== "string" || uri.trim() === "") return undefined
  if (uri.startsWith("file://")) {
    try { return fileURLToPath(uri) } catch { return undefined }
  }
  if (/^[a-zA-Z]:[\\/]/.test(uri) || uri.startsWith("\\\\")) return uri
  return undefined
}

function fileLabel(part: FilePart): string {
  if (typeof part.name === "string" && part.name.trim() !== "") return part.name
  if (typeof part.uri === "string" && part.uri.trim() !== "") {
    const tail = part.uri.split(/[\\/]/).pop() ?? part.uri
    if (tail.trim() !== "") return tail
  }
  return "unknown"
}

/** Build the JSON envelope the model receives instead of the raw PDF bytes. Pure. */
export function buildEnvelope(input: {
  file: string
  pages: number
  text: string
  charLimit?: number
}): PdfEnvelope {
  const charLimit = input.charLimit ?? DEFAULT_PDF_CHAR_LIMIT
  const trimmed = input.text.trim()
  const textLayer = trimmed.length >= NEAR_EMPTY_CHARS
  // Without a text layer there is nothing readable to hand over: report zero.
  const usable = textLayer ? input.text : ""
  const truncated = usable.length > charLimit
  const text = truncated ? usable.slice(0, charLimit) : usable
  const notes = [REPLACEMENT_NOTE]
  if (!textLayer) notes.push(OCR_NOTE)
  if (truncated) notes.push(`Extracted text was truncated at ${charLimit} characters.`)
  return {
    kind: "document",
    file: input.file,
    mime: "application/pdf",
    pages: input.pages,
    textLayer,
    chars: text.length,
    truncated,
    note: notes.join(" "),
    text,
  }
}

export interface PdfHandlerDeps {
  charLimit?: number
  sizeLimitBytes?: number
  onDebug?: (entry: unknown) => void
}

/**
 * Build the PDF interception handler. Returns `true` when it converted the
 * result, so a combined hook can skip the terminal shrink pipeline for that
 * event; `false` always means the result is untouched.
 */
export function createPdfHandler(deps: PdfHandlerDeps = {}) {
  const charLimit = deps.charLimit ?? DEFAULT_PDF_CHAR_LIMIT
  const sizeLimitBytes = deps.sizeLimitBytes ?? DEFAULT_PDF_SIZE_LIMIT_BYTES
  const debug = deps.onDebug ?? (() => {})

  return async function interceptPdf(event: CompletedToolEvent): Promise<boolean> {
    try {
      if (event.status !== "completed" || event.tool !== "read" || !event.result) return false
      const result: ToolResultLike = event.result
      const found = detectPdfPart(result.content)
      if (found.status === "none") return false
      if (found.status === "invalid") {
        const part = (result.content as unknown[])[found.index] as Record<string, unknown> | undefined
        debug({
          pdf: "unexpected-part-shape", index: found.index,
          keys: part ? Object.keys(part) : undefined,
          type: part?.type, mime: part?.mime, encoding: part?.encoding,
          uri: String(part?.uri ?? "<none>"), name: String(part?.name ?? "<none>"),
          contentType: typeof part?.content,
          contentKeys: part?.content && typeof part.content === "object" ? Object.keys(part.content as object).slice(0, 8) : undefined,
        })
        return false
      }

      let bytes: Uint8Array
      const inline = typeof found.part.content === "string"
        ? found.part.content
        : dataUrlPayload(found.part.uri)
      if (inline !== undefined) {
        // 4 base64 chars encode 3 bytes; keep the guard conservative (skip, not fail).
        const approxBytes = Math.floor((inline.length * 3) / 4)
        if (approxBytes > sizeLimitBytes) {
          debug({ pdf: "skipped-size", bytes: approxBytes, limit: sizeLimitBytes })
          return false
        }
        bytes = decodeBase64ToBytes(inline)
      } else {
        // Some host flows deliver the part without inline content, only a local URI.
        const path = uriToLocalPath(found.part.uri)
        if (!path) {
          debug({ pdf: "no-inline-content-and-no-local-uri", index: found.index, uri: String(found.part.uri ?? "") })
          return false
        }
        bytes = await readFile(path)
        if (bytes.length > sizeLimitBytes) {
          debug({ pdf: "skipped-size", bytes: bytes.length, limit: sizeLimitBytes })
          return false
        }
      }
      const { totalPages, text } = await extractText(bytes, { mergePages: true })
      const envelope = buildEnvelope({ file: fileLabel(found.part), pages: totalPages, text, charLimit })

      const replacement = { type: "text", text: JSON.stringify(envelope) }
      const content = result.content as unknown[]
      // When the host reports the model cannot ingest PDFs, that error text is
      // noise once the envelope exists — replace the whole content with it.
      const hasUnsupportedError = content.some((part) => {
        const text = (part as { type?: string; text?: unknown } | undefined)?.text
        return typeof text === "string" && text.includes("does not support pdf input")
      })
      if (content.length === 1 || hasUnsupportedError) result.content = [replacement]
      else content[found.index] = replacement
      return true
    } catch (error) {
      // Failure isolation: the host keeps its original result, diagnostics only.
      debug({ pdf: "error", error: String(error) })
      return false
    }
  }
}
