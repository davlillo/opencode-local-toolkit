import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { aggregate, appendStats, EMPTY_SUMMARY, formatBytes, readStats } from "./stats.ts"

const entry = (over: Partial<Parameters<typeof appendStats>[1]> = {}) => ({
  at: "2026-11-17T15:00:00Z", tool: "bash", reducer: "terminal",
  originalBytes: 10_000, outputBytes: 2_000, removedBytes: 8_000, ...over,
})

test("aggregates entries and groups by reducer, skipping malformed lines", () => {
  const content = [
    JSON.stringify(entry()),
    JSON.stringify(entry({ reducer: "search", originalBytes: 5_000, outputBytes: 1_000, removedBytes: 4_000 })),
    "not json",
    JSON.stringify(entry()),
    "",
  ].join("\n")
  const s = aggregate(content)
  expect(s.entries).toBe(3)
  expect(s.originalBytes).toBe(25_000)
  expect(s.outputBytes).toBe(5_000)
  expect(s.savedBytes).toBe(20_000)
  expect(s.byReducer.terminal.count).toBe(2)
  expect(s.byReducer.search.savedBytes).toBe(4_000)
  expect(s.lastAt).toBe("2026-11-17T15:00:00Z")
})

test("an entry without numbers or reducer is skipped, not counted", () => {
  const s = aggregate(JSON.stringify({ at: "x", tool: "bash" }))
  expect(s.entries).toBe(0)
  expect(s.byReducer).toEqual({})
})

test("append and read round-trip through a real file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "microtools-stats-"))
  try {
    const path = join(dir, "stats.ndjson")
    await appendStats(path, entry())
    await appendStats(path, entry({ reducer: "build", removedBytes: 1_000 }))
    const s = await readStats(path)
    expect(s.entries).toBe(2)
    expect(s.savedBytes).toBe(9_000)
    expect(s.byReducer.build.count).toBe(1)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("a missing file reports zeros instead of throwing", async () => {
  const s = await readStats(join(tmpdir(), "microtools-missing-" + Date.now(), "stats.ndjson"))
  expect(s.entries).toBe(0)
  expect(s).toEqual(EMPTY_SUMMARY)
})

test("formatBytes stays readable across magnitudes", () => {
  expect(formatBytes(0)).toBe("0 B")
  expect(formatBytes(512)).toBe("512 B")
  expect(formatBytes(2_048)).toBe("2.0 KB")
  expect(formatBytes(1_572_864)).toBe("1.5 MB")
})

test("a torn trailing line does not corrupt the aggregate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "microtools-torn-"))
  try {
    const path = join(dir, "stats.ndjson")
    await appendStats(path, entry())
    await writeFile(path, JSON.stringify(entry({ removedBytes: 500 })).slice(0, 12), { flag: "a" })
    const raw = await readFile(path, "utf8")
    expect(aggregate(raw).entries).toBe(1)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
