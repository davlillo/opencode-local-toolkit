/**
 * Byte and text helpers. Pure functions only: no I/O, no environment reads.
 */

const ANSI_CSI = /\u001b\[[0-9;?]*[A-Za-z]/g
const ANSI_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

export interface AnsiStripResult {
  text: string
  stripped: number
  removedBytes: number
}

/** Remove only escape sequences; surrounding printable text is preserved as is. */
export function stripAnsi(text: string): AnsiStripResult {
  let stripped = 0
  const withoutCodes = text.replace(ANSI_OSC, () => {
    stripped += 1
    return ""
  }).replace(ANSI_CSI, () => {
    stripped += 1
    return ""
  })
  return { text: withoutCodes, stripped, removedBytes: utf8Bytes(text) - utf8Bytes(withoutCodes) }
}

export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/)
}

/** Approximate, deliberately coarse. Never a provider token count. */
export const TOKENS_NOTE = "Approximate estimate (chars/4). Not a provider token count."

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function byteSuffix(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}
