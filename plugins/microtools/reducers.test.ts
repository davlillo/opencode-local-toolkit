import { describe, expect, test } from "bun:test"
import { planReduction, renderPlan } from "./reducers.ts"
import { reduceOutput } from "./lib.ts"
import { utf8Bytes } from "./text.ts"
import { makeScratchStore } from "./testing.ts"

// Fixtures are built inline; no binary artifacts in the repo.

const RESET = "\u001b[0m"
const CYAN = "\u001b[36m"
const RED = "\u001b[31m"

function buildLog(): string {
  const lines: string[] = [`${CYAN}$ tsc -p .${RESET}`, "Compiling 148 files..."]
  for (let i = 0; i < 40; i += 1) {
    lines.push(`\r  Building ${i * 2}% ${"=".repeat(i % 8)}`)
  }
  const error = "src/auth.ts(42,5): error TS2322: Type 'string' is not assignable to type 'number'."
  // Same error reported four times by four project references.
  for (let i = 0; i < 4; i += 1) lines.push(error)
  lines.push("src/db/connection.ts(17,9): error TS2304: Cannot find name 'pool'.")
  for (let i = 0; i < 2; i += 1) lines.push("src/db/connection.ts(17,9): error TS2304: Cannot find name 'pool'.")
  lines.push("src/ui/Button.tsx(8,3): warning TS6133: 'React' is declared but its value is never read.")
  lines.push("Found 2 errors in 2 files.")
  lines.push("Found 2 errors in 2 files.")
  return lines.join("\n")
}

function testRunnerLog(): string {
  const lines: string[] = [" RUN  v2.1.0 /repo", ""]
  for (let i = 0; i < 30; i += 1) lines.push(` ✓ src/unit/file-${i}.test.ts (3 tests) ${12 + i}ms`)
  lines.push(` ${RED}✗${RESET} src/cart/total.test.ts (4 tests | 1 failed) 5ms`)
  const failure = "AssertionError: expected 19.99 to be 20.00"
  for (let i = 0; i < 3; i += 1) lines.push(failure)
  lines.push(" Test Files  1 failed | 30 passed (31)")
  return lines.join("\n")
}

function terminalLog(): string {
  const lines: string[] = ["npm warn deprecated inflight@1.0.2: use lru-cache instead"]
  for (let i = 0; i < 50; i += 1) lines.push(`Progress: resolved ${i}, reused 0, downloaded ${i}, added 0`)
  lines.push("npm warn deprecated inflight@1.0.2: use lru-cache instead")
  lines.push("npm error code ELIFECYCLE")
  lines.push("npm error command failed: exit code 1")
  return lines.join("\n")
}

function searchLog(): string {
  const lines: string[] = []
  for (let i = 0; i < 20; i += 1) {
    lines.push(`src/components/panel-${i}.tsx:14:  const value = useMemo(() => compute(props), [props])`)
  }
  lines.push("src/hooks/use-debounce.ts:22:  const timer = useRef<number>()")
  return lines.join("\n")
}

const store = makeScratchStore()
const base = { storeDir: store.dir }

describe("determinism", () => {
  test("same input yields byte identical output across runs", () => {
    const first = planReduction("build", buildLog())
    const second = planReduction("build", buildLog())
    expect(renderPlan(second, {}, "local://logs/x")).toBe(renderPlan(first, {}, "local://logs/x"))
    expect(second.notes).toEqual(first.notes)
    expect(second.duplicatesRemoved).toBe(first.duplicatesRemoved)
  })
})

describe("rule: exact duplicate lines collapsed with a counter", () => {
  test("duplicate summary line is collapsed and counted", () => {
    const plan = planReduction("terminal", terminalLog())
    expect(plan.duplicatesRemoved).toBeGreaterThan(0)
    expect(plan.text).toContain("(x2)")
    expect(plan.text.match(/npm warn deprecated inflight/g)?.length).toBe(1)
  })
})

describe("rule: consecutive progress lines collapsed", () => {
  test("percentage progress run becomes one line", () => {
    const plan = planReduction("terminal", terminalLog())
    expect(plan.text.match(/Progress: resolved/g)?.length).toBe(1)
    expect(plan.notes.some((n) => n.ruleId === "rule.progress.collapse")).toBe(true)
  })

  test("carriage return build progress is collapsed, not dropped silently", () => {
    const plan = planReduction("build", buildLog())
    expect(plan.notes.some((n) => n.ruleId === "rule.progress.collapse")).toBe(true)
    expect(plan.text).toContain("Building")
    expect(plan.text).not.toContain("\r")
  })
})

describe("rule: identical errors grouped with an occurrence count", () => {
  test("repeated tsc error becomes one grouped entry", () => {
    const plan = planReduction("build", buildLog())
    const occurrences = plan.text.match(/Type 'string' is not assignable/g)
    expect(occurrences?.length).toBe(1)
    expect(plan.text).toContain("(x4)")
    expect(plan.errors.some((e) => e.code === "TS2322" && e.occurrences === 4)).toBe(true)
  })

  test("file, line, code and message stay verbatim for every distinct error", () => {
    const plan = planReduction("build", buildLog())
    expect(plan.text).toContain(
      "src/auth.ts(42,5): error TS2322: Type 'string' is not assignable to type 'number'.",
    )
    expect(plan.text).toContain("src/db/connection.ts(17,9): error TS2304: Cannot find name 'pool'.")
    expect(plan.errors.map((e) => [e.file, e.line, e.code])).toEqual([
      ["src/auth.ts", 42, "TS2322"],
      ["src/db/connection.ts", 17, "TS2304"],
    ])
  })

  test("distinct errors keep deterministic first-seen order", () => {
    const plan = planReduction("build", buildLog())
    expect(plan.errors[0]?.file).toBe("src/auth.ts")
  })
})

describe("rule: truncation only with an explicit marker and never for error lines", () => {
  test("oversized output carries a marker and the full output reference", () => {
    const plan = planReduction("test", testRunnerLog(), { maxOutputBytes: 600 })
    expect(plan.truncated).toBe(true)
    const text = renderPlan(plan, {}, "local://logs/abc")
    expect(text).toContain("microtools: truncated")
    expect(text).toContain("local://logs/abc")
  })

  test("error lines survive an aggressive budget", async () => {
    const result = await reduceOutput("build", buildLog(), { ...base, maxOutputBytes: 200 })
    expect(result.truncated).toBe(true)
    expect(result.text).toContain("TS2322")
    expect(result.text).toContain("TS2304")
    expect(result.text).toContain("microtools: truncated")
    expect(result.originalRef).toMatch(/^local:\/\/logs\/[0-9a-f]{64}$/)
  })

  test("no marker when everything fits", () => {
    const plan = planReduction("search", searchLog(), { maxOutputBytes: 100_000 })
    expect(plan.truncated).toBe(false)
    expect(plan.text).not.toContain("microtools: truncated")
  })
})

describe("ANSI handling", () => {
  test("escape codes are stripped while text survives", () => {
    const plan = planReduction("build", buildLog())
    expect(plan.text).not.toContain("\u001b[")
    expect(plan.text).toContain("tsc -p .")
    expect(plan.notes.some((n) => n.ruleId === "rule.ansi.strip")).toBe(true)
  })
})

describe("size accounting", () => {
  test("removed bytes equal input minus output bytes", () => {
    const input = buildLog()
    const plan = planReduction("build", input)
    expect(plan.originalBytes).toBe(utf8Bytes(input))
    expect(plan.removedBytes).toBe(plan.originalBytes - utf8Bytes(plan.text))
    expect(plan.removedBytes).toBeGreaterThan(0)
  })
})

describe("per reducer flags", () => {
  test("disabled reducer passes content through unchanged", async () => {
    const input = terminalLog()
    const result = await reduceOutput("terminal", input, { ...base, enabled: { terminal: false } })
    expect(result.status).toBe("unchanged")
    expect(result.text).toBe(input)
    expect(result.removedBytes).toBe(0)
    expect(result.originalRef).toMatch(/^local:\/\/logs\//)
  })

  test("each reducer is independent", async () => {
    const input = buildLog()
    const result = await reduceOutput("build", input, { ...base, enabled: { search: false } })
    expect(result.status).not.toBe("unchanged")
    expect(result.text).toContain("(x4)")
  })
})

describe("diagnostic mode", () => {
  test("notes always carry rule ids and counts, without content", () => {
    const plan = planReduction("build", buildLog())
    expect(plan.notes.length).toBeGreaterThan(0)
    for (const note of plan.notes) {
      expect(note.ruleId).toMatch(/^rule\./)
      expect(note.count).toBeGreaterThan(0)
      expect(note.explanation).toBeUndefined()
    }
  })

  test("diagnostics explain each removal and add per line reasons", () => {
    const plan = planReduction("build", buildLog(), { diagnostics: true })
    for (const note of plan.notes) expect(note.explanation?.length).toBeGreaterThan(0)
    expect(plan.diagnostics.length).toBeGreaterThan(0)
    expect(plan.diagnostics[0]?.ruleId).toMatch(/^rule\./)
  })
})

describe("status", () => {
  test("errors make the status failed and warnings are counted", () => {
    const plan = planReduction("build", buildLog())
    expect(plan.status).toBe("failed")
    expect(plan.warnings).toBe(1)
  })

  test("clean output is ok and empty input is empty", () => {
    expect(planReduction("terminal", "hello\n").status).toBe("ok")
    expect(planReduction("terminal", "   \n\n").status).toBe("empty")
  })
})

describe("approximate token estimate", () => {
  test("is labelled approximate and never exact", async () => {
    const result = await reduceOutput("build", buildLog(), base)
    expect(result.tokens.approximate).toBe(true)
    expect(result.tokens.basis).toBe("chars/4")
    expect(result.tokens.value).toBe(Math.ceil(result.text.length / 4))
    expect(result.tokens.note.toLowerCase()).toContain("approximate")
  })
})
