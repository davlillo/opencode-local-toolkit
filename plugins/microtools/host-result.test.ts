import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DEFAULT_THRESHOLD_BYTES, createShrinkHandler, readResultText, reducerForTool } from "./host-result.ts"
import { resolveOriginal } from "./store.ts"

async function withStore(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "microtools-host-"))
  try { await run(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}

function noisyOutput(lines: number): string {
  const repeated = "  Compiling dependency graph for target release"
  return Array.from({ length: lines }, () => repeated).join("\n")
}

test("reads string content and array of text parts, and ignores binary shapes", () => {
  const text = readResultText({ content: "hello" })
  expect(text?.text).toBe("hello")

  const array = readResultText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })
  expect(array?.text).toBe("a\nb")

  expect(readResultText({ content: [{ type: "image", data: "x" }] })).toBeUndefined()
  expect(readResultText({})).toBeUndefined()
})

test("writing back preserves the original result shape", () => {
  const single = { content: [{ type: "text", text: "old" }] }
  readResultText(single)!.write("new")
  expect(single.content).toEqual([{ type: "text", text: "new" }])

  const many = { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }
  readResultText(many)!.write("merged")
  expect(many.content).toEqual([{ type: "text", text: "merged" }])
})

test("maps known tool names and falls back to content detection", () => {
  expect(reducerForTool("grep", "anything")).toBe("search")
  expect(reducerForTool("bash", "src/a.ts:12: hit")).toBe("search")
  expect(reducerForTool("bash", "noise")).toBe("terminal")
  expect(reducerForTool("unknown-tool", "error TS2322: Type mismatch")).toBe("build")
})

test("shrinks a large completed result, keeps the original recoverable", async () => {
  await withStore(async (storeDir) => {
    const raw = noisyOutput(40)
    const event = {
      tool: "bash",
      status: "completed" as const,
      result: { content: raw, metadata: { exitCode: 0 } },
    }
    const handler = createShrinkHandler({ storeDir, thresholdBytes: 100 })
    await handler(event)

    expect(event.result.content.length).toBeLessThan(raw.length)
    const metadata = event.result.metadata as Record<string, unknown>
    const marked = metadata.microtools as { removedBytes: number; originalRef: string }
    expect(marked.removedBytes).toBeGreaterThan(0)
    expect(await resolveOriginal(marked.originalRef, { storeDir })).toBe(raw)
    expect(metadata.exitCode).toBe(0)
  })
})

test("leaves small results, failures and non-text results untouched", async () => {
  await withStore(async (storeDir) => {
    const handler = createShrinkHandler({ storeDir, thresholdBytes: DEFAULT_THRESHOLD_BYTES })
    const small = { content: "tiny" }
    await handler({ tool: "bash", status: "completed", result: small })
    expect(small.content).toBe("tiny")

    const failed = { content: noisyOutput(40) }
    await handler({ tool: "bash", status: "error", result: failed })
    expect(failed.content).toBe(noisyOutput(40))

    const binary = { content: [{ type: "image", data: "z" }] }
    await handler({ tool: "bash", status: "completed", result: binary })
    expect(binary.content).toEqual([{ type: "image", data: "z" }])
  })
})

test("a storage failure leaves the host result intact and reports once", async () => {
  const reported: unknown[] = []
  const raw = noisyOutput(60)
  const event = { tool: "bash", status: "completed" as const, result: { content: raw } }
  const blocked = join(await mkdtemp(join(tmpdir(), "microtools-blocked-")), "file-not-dir")
  await writeFile(blocked, "")
  try {
    const handler = createShrinkHandler({
      storeDir: join(blocked, "nested"),
      thresholdBytes: 10,
      onError: (error) => reported.push(error),
    })
    await handler(event)
    expect(event.result.content).toBe(raw)
    expect(reported.length).toBe(1)
  } finally { await rm(dirname(blocked), { recursive: true, force: true }) }
})
