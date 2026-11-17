import { describe, expect, test } from "bun:test"
import { reduceOutput } from "./lib.ts"
import { makeScratchStore } from "./testing.ts"
import { utf8Bytes } from "./text.ts"

const store = makeScratchStore()
const base = { storeDir: store.dir }

const NOISY = [
  "$ bun test ./",
  "\u001b[32m✓\u001b[0m src/a.test.ts (2 tests) 4ms",
  "\u001b[32m✓\u001b[0m src/b.test.ts (2 tests) 5ms",
  "\u001b[31m✗\u001b[0m src/c.test.ts (2 tests | 1 failed) 6ms",
  "error: expect(received).toBe(expected)",
  "  src/c.test.ts:12:3 expect(value).toBe(2)",
  "error: expect(received).toBe(expected)",
  "  src/c.test.ts:12:3 expect(value).toBe(2)",
  "Received: 1",
  "    at src/c.test.ts:12:3",
  " 1 failed | 2 passed (3)",
].join("\n")

describe("no silent loss", () => {
  test("every reduced result carries an original reference and removed size", async () => {
    const result = await reduceOutput("test", NOISY, base)
    expect(result.originalRef).toMatch(/^local:\/\/logs\/[0-9a-f]{64}$/)
    expect(result.removedBytes).toBeGreaterThan(0)
    expect(result.originalBytes).toBe(utf8Bytes(NOISY))
    expect(result.outputBytes).toBe(utf8Bytes(result.text))
  })

  test("the reference resolves to the exact original, byte for byte", async () => {
    const result = await reduceOutput("test", NOISY, { ...base, maxOutputBytes: 120 })
    const { resolveOriginal } = await import("./store.ts")
    const original = await resolveOriginal(result.originalRef, { storeDir: store.dir })
    expect(Buffer.from(original)).toEqual(Buffer.from(NOISY))
  })

  test("truncating still stores the whole original", async () => {
    const huge = Array.from({ length: 500 }, (_, i) => `line ${i} of noise`).join("\n")
    const result = await reduceOutput("terminal", huge, { ...base, maxOutputBytes: 64 })
    expect(result.truncated).toBe(true)
    const { resolveOriginal } = await import("./store.ts")
    expect(await resolveOriginal(result.originalRef, { storeDir: store.dir })).toBe(huge)
  })

  test("store bound failure is reported before any lossy output is returned", async () => {
    const error = await reduceOutput("terminal", NOISY, { ...base, maxStoreBytes: 8 }).catch((e: unknown) => e)
    expect((error as Error).message).toContain("too large")
  })
})

describe("search reducer", () => {
  const HITS = [
    "src/a.ts:1:  const x = 1",
    "src/a.ts:1:  const x = 1",
    "src/a.ts:9:  const y = 2",
    "src/b.ts:30:  const z = 3",
    "Found 3 matches",
  ].join("\n")

  test("groups repeated hits and keeps path:line text", async () => {
    const result = await reduceOutput("search", HITS, base)
    expect(result.reduceId).toBe("search")
    expect(result.text.match(/const x = 1/g)?.length).toBe(1)
    expect(result.text).toContain("src/a.ts:9:")
    expect(result.hits).toBe(3)
  })

  test("search status is ok when matches exist", async () => {
    const result = await reduceOutput("search", HITS, base)
    expect(result.status).toBe("ok")
  })
})

describe("reduction pipeline", () => {
  test("original text is never mutated and reducers do not write files", async () => {
    const before = NOISY
    await reduceOutput("test", NOISY, base)
    expect(NOISY).toBe(before)
  })

  test("reducing twice does not summarize an already summarized text", async () => {
    const once = await reduceOutput("test", NOISY, base)
    const twice = await reduceOutput("test", once.text, base)
    expect(twice.duplicatesRemoved).toBe(0)
    expect(twice.text).toContain("expect(value).toBe(2)")
  })

  test("failures are never silently dropped when budget is tiny", async () => {
    const result = await reduceOutput("test", NOISY, { ...base, maxOutputBytes: 40 })
    expect(result.text).toContain("expect(value).toBe(2)")
    expect(result.status).toBe("failed")
  })
})
