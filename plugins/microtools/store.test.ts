import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  OriginalOutputTooLargeError,
  UnknownReferenceError,
  originalRefFor,
  putOriginal,
  resolveOriginal,
} from "./store.ts"
import { utf8Bytes } from "./text.ts"

const dirs: string[] = []

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "microtools-store-"))
  dirs.push(dir)
  return dir
}

const SAMPLE = "line one\r\nli\u00f1e two \u2713\n\ttrailing tab\t\nno newline at end"
const BINARY_ISH = "\u0000\u0001\u0002 raw\u00a0bytes \u{1f600}\n"

describe("original output store", () => {
  test("round trips the exact bytes of a mixed line ending payload", async () => {
    const dir = await scratch()
    const ref = await putOriginal(SAMPLE, { storeDir: dir })
    const restored = await resolveOriginal(ref, { storeDir: dir })
    expect(restored).toBe(SAMPLE)
    expect(Buffer.from(restored)).toEqual(Buffer.from(SAMPLE))
    expect(utf8Bytes(restored)).toBe(utf8Bytes(SAMPLE))
  })

  test("round trips control characters and astral code points", async () => {
    const dir = await scratch()
    const ref = await putOriginal(BINARY_ISH, { storeDir: dir })
    expect(await resolveOriginal(ref, { storeDir: dir })).toBe(BINARY_ISH)
  })

  test("reference is a local:// hash key and is stable for identical content", async () => {
    const dir = await scratch()
    const first = await putOriginal(SAMPLE, { storeDir: dir })
    const second = await putOriginal(SAMPLE, { storeDir: dir })
    expect(first).toMatch(/^local:\/\/logs\/[0-9a-f]{64}$/)
    expect(second).toBe(first)
    expect(first).toBe(originalRefFor(SAMPLE))
  })

  test("writes one file per unique payload, not per call", async () => {
    const dir = await scratch()
    await putOriginal(SAMPLE, { storeDir: dir })
    await putOriginal(SAMPLE, { storeDir: dir })
    expect((await readdir(dir)).length).toBe(1)
  })

  test("bound is enforced with a clear error and no partial file", async () => {
    const dir = await scratch()
    const error = await putOriginal(SAMPLE, { storeDir: dir, maxStoreBytes: 10 }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OriginalOutputTooLargeError)
    expect((error as Error).message).toContain("maxStoreBytes")
    expect((error as Error).message).toContain(String(utf8Bytes(SAMPLE)))
    expect(await readdir(dir)).toEqual([])
  })

  test("payload exactly at the bound is accepted", async () => {
    const dir = await scratch()
    const ref = await putOriginal(SAMPLE, { storeDir: dir, maxStoreBytes: utf8Bytes(SAMPLE) })
    expect(await resolveOriginal(ref, { storeDir: dir })).toBe(SAMPLE)
  })

  test("requires a caller supplied directory", async () => {
    const error = await putOriginal(SAMPLE, { storeDir: "" }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("storeDir")
  })

  test("unknown reference fails clearly", async () => {
    const dir = await scratch()
    const missing = `local://logs/${"a".repeat(64)}`
    const error = await resolveOriginal(missing, { storeDir: dir }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(UnknownReferenceError)
    expect((error as Error).message).toContain(missing)
  })

  test("malformed reference fails clearly", async () => {
    const dir = await scratch()
    const error = await resolveOriginal("logs/123", { storeDir: dir }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("local://")
  })

  test("tampered content is detected on resolve", async () => {
    const dir = await scratch()
    const ref = await putOriginal(SAMPLE, { storeDir: dir })
    const file = join(dir, ref.slice("local://logs/".length))
    await Bun.write(file, "different payload")
    expect(resolveOriginal(ref, { storeDir: dir })).rejects.toThrow(/hash/)
  })
})

describe("no writes inside the plugin source tree", () => {
  test("store directory is exactly the provided one", async () => {
    const dir = await scratch()
    await putOriginal("payload", { storeDir: dir })
    const entries = await readdir(dir)
    expect(entries.length).toBe(1)
    expect(entries[0]).toMatch(/^[0-9a-f]{64}$/)
  })
})
