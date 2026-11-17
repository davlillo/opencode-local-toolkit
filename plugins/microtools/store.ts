/**
 * Lossless original-output store. One file per content hash, written into a
 * caller-provided directory. Nothing is ever written into the plugin tree.
 */

import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { utf8Bytes } from "./text.ts"
import type { StoreOptions } from "./types.ts"

export const REF_PREFIX = "local://logs/"
export const DEFAULT_MAX_STORE_BYTES = 8 * 1024 * 1024

export class OriginalOutputTooLargeError extends Error {
  readonly bytes: number
  readonly maxStoreBytes: number

  constructor(bytes: number, maxStoreBytes: number) {
    super(`Original output is too large: ${bytes} bytes exceeds maxStoreBytes ${maxStoreBytes} bytes.`)
    this.name = "OriginalOutputTooLargeError"
    this.bytes = bytes
    this.maxStoreBytes = maxStoreBytes
  }
}

export class UnknownReferenceError extends Error {
  readonly ref: string

  constructor(ref: string, reason = "no stored original matches this reference") {
    super(`Unknown original reference ${ref}: ${reason}.`)
    this.name = "UnknownReferenceError"
    this.ref = ref
  }
}

export function hashBytes(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

/** Reference for content, without touching the disk. */
export function originalRefFor(text: string): string {
  return `${REF_PREFIX}${hashBytes(text)}`
}

export function refToFileName(ref: string): string {
  if (!ref.startsWith(REF_PREFIX)) {
    throw new Error(`Reference must start with ${REF_PREFIX} (received "${ref.slice(0, 40)}").`)
  }
  const name = ref.slice(REF_PREFIX.length)
  if (!/^[0-9a-f]{64}$/.test(name)) {
    throw new Error(`Reference payload must be 64 lowercase hex characters (received "${name}").`)
  }
  return name
}

function requireStoreDir(options: StoreOptions): string {
  if (typeof options.storeDir !== "string" || options.storeDir.trim() === "") {
    throw new Error("storeDir is required: pass a writable directory outside the plugin source tree.")
  }
  return options.storeDir
}

/**
 * Store the complete original. Idempotent for identical content.
 * Fails loudly before writing when the payload exceeds the bound.
 */
export async function putOriginal(text: string, options: StoreOptions): Promise<string> {
  const storeDir = requireStoreDir(options)
  const maxStoreBytes = options.maxStoreBytes ?? DEFAULT_MAX_STORE_BYTES
  const bytes = utf8Bytes(text)
  if (bytes > maxStoreBytes) throw new OriginalOutputTooLargeError(bytes, maxStoreBytes)

  const ref = originalRefFor(text)
  const file = join(storeDir, refToFileName(ref))
  await mkdir(storeDir, { recursive: true })
  await writeFile(file, text, "utf8")
  return ref
}

/** Read back the exact original. Verifies the content hash first. */
export async function resolveOriginal(ref: string, options: StoreOptions): Promise<string> {
  const storeDir = requireStoreDir(options)
  const file = join(storeDir, refToFileName(ref))
  let text: string
  try {
    text = await readFile(file, "utf8")
  } catch {
    throw new UnknownReferenceError(ref)
  }
  const actual = originalRefFor(text)
  if (actual !== ref) {
    throw new UnknownReferenceError(ref, `stored content hashes to ${actual}`)
  }
  return text
}

export function isOriginalRef(value: string): boolean {
  return value.startsWith(REF_PREFIX) && /^[0-9a-f]{64}$/.test(value.slice(REF_PREFIX.length))
}
