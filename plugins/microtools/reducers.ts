/**
 * Deterministic reducers. Pure: same input, same plan. No I/O, no model,
 * no clock, no randomness.
 *
 * Rules are identified so a later UI can explain every removal:
 *   rule.ansi.strip        escape codes removed, text kept
 *   rule.progress.collapse consecutive progress/spinner/percentage run folded
 *   rule.error.group       identical diagnostics grouped with a count
 *   rule.duplicate.collapse exact duplicate lines folded with a count
 *   rule.blank.collapse    runs of blank lines folded
 *   rule.truncate.budget   non-error lines dropped past the byte budget
 */

import { splitLines, stripAnsi, utf8Bytes } from "./text.ts"
import type {
  LineDiagnostic,
  PlannedLine,
  ReductionError,
  ReductionNote,
  ReductionOptions,
  ReductionPlan,
  ReductionStatus,
  ReducerId,
} from "./types.ts"

export const DEFAULT_MAX_OUTPUT_BYTES = 4096

const EXPLANATIONS: Record<string, string> = {
  "rule.ansi.strip": "ANSI escape sequences were removed; printable text was kept.",
  "rule.progress.collapse": "Consecutive progress lines were folded into the last one.",
  "rule.error.group": "Identical diagnostics were grouped; file, line, code and message stay verbatim.",
  "rule.duplicate.collapse": "Exact duplicate lines were folded into the first occurrence.",
  "rule.blank.collapse": "Consecutive blank lines were folded into one.",
  "rule.truncate.budget": "Non-error lines past the byte budget were dropped; error lines are exempt.",
  "rule.reducer.disabled": "The reducer is disabled, so the text passes through unchanged.",
}

interface ErrorMatch {
  file?: string
  line?: number
  code?: string
  message: string
}

const ERROR_PATTERNS: RegExp[] = [
  /^(?<file>[^\s(]+)\((?<line>\d+),(?<col>\d+)\): error (?<code>[A-Z]+\d+): (?<msg>.+)$/,
  /^(?<file>[^\s:]+):(?<line>\d+):(?<col>\d+): error (?<code>[A-Z]+\d+): (?<msg>.+)$/,
  /^(?<file>[^\s:]+):(?<line>\d+):(?<col>\d+): error: (?<msg>.+)$/,
  /^error\[(?<code>[A-Z]+\d+)\]: (?<msg>.+)$/,
  /^ERROR in (?<file>.+?) (?<line>\d+):(?<col>\d+)$/,
  /^ERROR: (?<msg>.+)$/,
]

const WARNING_PATTERNS: RegExp[] = [
  /^(?<file>[^\s(]+)\((?<line>\d+),(?<col>\d+)\): warning (?<code>[A-Z]+\d+): (?<msg>.+)$/,
  /^(?<file>[^\s:]+):(?<line>\d+):(?<col>\d+): warning: (?<msg>.+)$/,
  /^warning\[(?<code>[A-Z]+\d+)\]: (?<msg>.+)$/,
]

/** Failure shapes specific to test runners. */
const TEST_ERROR_PATTERNS: RegExp[] = [
  /^\s*(?:●|✗|×)\s/,
  /^\s*FAIL\s/,
  /AssertionError/,
  /\d+:\d+.*expect\(/,
  /^\s*Error: /,
  /^\s*Received: /,
  /^\s*Expected: /,
]

/** Failure shapes specific to a plain shell. */
const TERMINAL_ERROR_PATTERNS: RegExp[] = [
  /^\s*(?:npm |bun |pnpm )?error\b/i,
  /\bexit code [1-9]/i,
  /^Error: /,
  /^\s*panic: /,
]

const SPINNER = /^\s*[\\|/-]\s+\S/
const BAR = /^\s*\[[=#>\-. ]{3,}\]\s*\d*%?\s*$/
const HIT = /^(?<file>[^\s:][^\s]*?):(?<line>\d+):(?<text>.*)$/

function matchDiagnostic(patterns: RegExp[], line: string): ErrorMatch | undefined {
  for (const pattern of patterns) {
    const found = pattern.exec(line)
    if (found === null) continue
    const groups = found.groups ?? {}
    return {
      file: groups.file,
      line: groups.line === undefined ? undefined : Number(groups.line),
      code: groups.code,
      message: groups.msg ?? line.trim(),
    }
  }
  return undefined
}

function diagnosticKey(match: ErrorMatch): string {
  return [match.file ?? "", match.line ?? "", match.code ?? "", match.message].join("\u0000")
}

type Kind = "error" | "warning" | "progress" | "hit" | "other"

interface Classified {
  text: string
  kind: Kind
  lineNumber: number
}

interface ExtraResult {
  warnings: number
  hits: number
}

/**
 * Loose detection of the tool family. Exposed so callers can pick a reducer
 * when they do not know it, and so disabled reducers still report a status.
 */
export function detectReducer(text: string): ReducerId {
  const sample = stripAnsi(text).text
  if (/\bTS\d{4}\b|ERROR in |error\[E\d{3,4}\]|^>?\s*tsc\b/m.test(sample)) return "build"
  if (/\b(?:RUN|Test Files|Tests)\b.*\d|\bvitest\b|\bbun test\b|✓ .*\.test\.ts/.test(sample)) return "test"
  if (/^[^\s:]+:\d+:./m.test(sample)) return "search"
  return "terminal"
}

function progressPattern(kind: Kind): RegExp[] {
  const patterns = [SPINNER, BAR, /^\s*Progress: /, /\b\d{1,3}\s?%/]
  if (kind === "error" || kind === "hit") return patterns
  return patterns
}

function errorPatternsFor(reduceId: ReducerId): RegExp[] {
  switch (reduceId) {
    case "build":
      return ERROR_PATTERNS
    case "test":
      return [...ERROR_PATTERNS, ...TEST_ERROR_PATTERNS]
    case "terminal":
      return [...ERROR_PATTERNS, ...TERMINAL_ERROR_PATTERNS]
    case "search":
      return []
  }
}

function classify(reduceId: ReducerId, rawText: string): { lines: Classified[]; ansi: { count: number; bytes: number } } {
  const raw = splitLines(rawText)
  const errorPatterns = errorPatternsFor(reduceId)
  // Search results are hits, never progress, even when they contain a percent sign.
  const progress = progressPattern(reduceId === "search" ? "hit" : "other")
  const lines: Classified[] = []
  let ansiCount = 0
  let ansiBytes = 0

  raw.forEach((rawLine, index) => {
    const stripped = stripAnsi(rawLine)
    if (stripped.stripped > 0) {
      ansiCount += 1
      ansiBytes += stripped.removedBytes
    }
    const text = stripped.text.replace(/[ \t]+$/, "")
    let kind: Kind = "other"

    if (reduceId === "search") {
      if (HIT.test(text)) kind = "hit"
    } else if (matchDiagnostic([...errorPatterns, ...WARNING_PATTERNS], text) !== undefined) {
      kind = matchDiagnostic(WARNING_PATTERNS, text) !== undefined ? "warning" : "error"
    }
    if (kind === "other" && text.trim() !== "" && progress.some((pattern) => pattern.test(text))) {
      kind = "progress"
    }
    lines.push({ text, kind, lineNumber: index + 1 })
  })

  return { lines, ansi: { count: ansiCount, bytes: ansiBytes } }
}

function addNote(notes: ReductionNote[], ruleId: string, count: number, removedBytes: number, diagnostics: boolean): void {
  if (count <= 0) return
  const existing = notes.find((note) => note.ruleId === ruleId)
  if (existing !== undefined) {
    existing.count += count
    existing.removedBytes += removedBytes
    return
  }
  const note: ReductionNote = { ruleId, count, removedBytes }
  if (diagnostics) note.explanation = EXPLANATIONS[ruleId] ?? ruleId
  notes.push(note)
}

interface Folded {
  line: PlannedLine
  count: number
  key: string
  kind: Kind
}

/**
 * Build a reduction plan. Deterministic: output order follows first appearance.
 */
export function planReduction(
  reduceId: ReducerId,
  rawText: string,
  options: ReductionOptions = {},
): ReductionPlan {
  const diagnostics = options.diagnostics === true
  const budget = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  if (!Number.isFinite(budget) || budget < 1) {
    throw new Error("maxOutputBytes must be a positive byte count.")
  }

  const originalBytes = utf8Bytes(rawText)
  const notes: ReductionNote[] = []
  const lineDiagnostics: LineDiagnostic[] = []
  const errors: ReductionError[] = []
  const errorIndex = new Map<string, ReductionError>()
  const duplicates = new Map<string, Folded>()
  const extra: ExtraResult = { warnings: 0, hits: 0 }

  const { lines, ansi } = classify(reduceId, rawText)
  addNote(notes, "rule.ansi.strip", ansi.count, ansi.bytes, diagnostics)

  const kept: Folded[] = []
  const byKey = new Map<string, Folded>()
  let progressRun: Classified[] = []

  const flushProgress = (): void => {
    if (progressRun.length === 0) return
    if (progressRun.length === 1) {
      const only = progressRun[0]!
      const folded: Folded = { line: { text: only.text, isError: false, lineNumber: only.lineNumber }, count: 1, key: "", kind: "progress" }
      kept.push(folded)
      progressRun = []
      return
    }
    const last = progressRun[progressRun.length - 1]!
    const removedBytes = progressRun.slice(0, -1).reduce((sum, line) => sum + utf8Bytes(line.text) + 1, 0)
    const folded: Folded = {
      line: { text: last.text, isError: false, lineNumber: last.lineNumber },
      count: progressRun.length,
      key: "",
      kind: "progress",
    }
    kept.push(folded)
    if (diagnostics) {
      for (const line of progressRun.slice(0, -1)) {
        lineDiagnostics.push({
          lineNumber: line.lineNumber,
          action: "collapsed",
          ruleId: "rule.progress.collapse",
          lineBytes: utf8Bytes(line.text),
        })
      }
    }
    addNote(notes, "rule.progress.collapse", progressRun.length - 1, removedBytes, diagnostics)
    progressRun = []
  }

  for (const entry of lines) {
    if (entry.kind === "progress") {
      progressRun.push(entry)
      continue
    }
    // A blank line between progress updates does not end the run; carriage
    // return separated updates commonly split into blank-plus-update pairs.
    if (entry.text === "" && progressRun.length > 0) continue
    flushProgress()

    if (entry.kind === "warning") extra.warnings += 1

    if (entry.kind === "error" || entry.kind === "warning") {
      const match = matchDiagnostic(entry.kind === "warning" ? WARNING_PATTERNS : errorPatternsFor(reduceId), entry.text) ?? {
        message: entry.text.trim(),
      }
      const key = diagnosticKey(match)
      // Warnings are grouped too, but only errors are registered as diagnostics.
      const existing = byKey.get(key)
      if (existing !== undefined && entry.kind === "error") {
        const record = errorIndex.get(key)!
        record.occurrences += 1
        existing.count += 1
        if (diagnostics) {
          lineDiagnostics.push({
            lineNumber: entry.lineNumber,
            action: "grouped",
            ruleId: "rule.error.group",
            lineBytes: utf8Bytes(entry.text),
          })
        }
        addNote(notes, "rule.error.group", 1, utf8Bytes(entry.text) + 1, diagnostics)
        continue
      }
      const folded: Folded = {
        line: { text: entry.text, isError: entry.kind === "error", lineNumber: entry.lineNumber },
        count: 1,
        key,
        kind: entry.kind,
      }
      kept.push(folded)
      if (entry.kind === "error") {
        byKey.set(key, folded)
        const record: ReductionError = {
          file: match.file,
          line: match.line,
          code: match.code,
          message: match.message,
          occurrences: 1,
          text: entry.text,
        }
        errorIndex.set(key, record)
        errors.push(record)
      }
      continue
    }

    if (entry.kind === "hit") {
      extra.hits += 1
      const hit = HIT.exec(entry.text)!
      const key = `hit\u0000${hit.groups!.file}\u0000${hit.groups!.line}\u0000${hit.groups!.text}`
      const existing = byKey.get(key)
      if (existing !== undefined) {
        existing.count += 1
        if (diagnostics) {
          lineDiagnostics.push({
            lineNumber: entry.lineNumber,
            action: "grouped",
            ruleId: "rule.duplicate.collapse",
            lineBytes: utf8Bytes(entry.text),
          })
        }
        addNote(notes, "rule.duplicate.collapse", 1, utf8Bytes(entry.text) + 1, diagnostics)
        extra.hits -= 1
        continue
      }
      const folded: Folded = { line: { text: entry.text, isError: false, lineNumber: entry.lineNumber }, count: 1, key, kind: "hit" }
      kept.push(folded)
      byKey.set(key, folded)
      continue
    }

    if (entry.text === "") {
      const previous = kept[kept.length - 1]
      if (previous !== undefined && previous.key === "blank") {
        previous.count += 1
        if (diagnostics) {
          lineDiagnostics.push({ lineNumber: entry.lineNumber, action: "dropped", ruleId: "rule.blank.collapse", lineBytes: 0 })
        }
        addNote(notes, "rule.blank.collapse", 1, 1, diagnostics)
        continue
      }
      const folded: Folded = { line: { text: "", isError: false, lineNumber: entry.lineNumber }, count: 1, key: "blank", kind: "other" }
      kept.push(folded)
      continue
    }

    const key = `dup\u0000${entry.text}`
    const duplicate = byKey.get(key)
    if (duplicate !== undefined) {
      duplicate.count += 1
      if (diagnostics) {
        lineDiagnostics.push({
          lineNumber: entry.lineNumber,
          action: "grouped",
          ruleId: "rule.duplicate.collapse",
          lineBytes: utf8Bytes(entry.text),
        })
      }
      addNote(notes, "rule.duplicate.collapse", 1, utf8Bytes(entry.text) + 1, diagnostics)
      duplicates.set(key, duplicate)
      continue
    }
    const folded: Folded = { line: { text: entry.text, isError: false, lineNumber: entry.lineNumber }, count: 1, key, kind: "other" }
    kept.push(folded)
    byKey.set(key, folded)
  }
  flushProgress()

  // Trailing blank lines carry no information.
  while (kept.length > 0 && kept[kept.length - 1]!.key === "blank") {
    const removed = kept.pop()!
    addNote(notes, "rule.blank.collapse", 1, 1, diagnostics)
  }

  const duplicatesRemoved = errors.reduce((sum, error) => sum + error.occurrences - 1, 0)
    + [...duplicates.values()].reduce((sum, entry) => sum + entry.count - 1, 0)
    + [...byKey.values()].filter((entry) => entry.kind === "hit").reduce((sum, entry) => sum + entry.count - 1, 0)

  const rendered = kept.map((entry) => ({
    text: entry.count > 1 && entry.key !== "blank" ? `${entry.line.text} (x${entry.count})` : entry.line.text,
    isError: entry.line.isError,
    lineNumber: entry.line.lineNumber,
  }))

  // Truncation: error lines always survive.
  let cursor = 0
  let removedLines = 0
  let removedLineBytes = 0
  let truncated = false
  const finalLines: string[] = []
  for (const line of rendered) {
    const size = utf8Bytes(line.text) + 1
    if (line.isError || cursor + size <= budget) {
      finalLines.push(line.text)
      cursor += size
      if (diagnostics) {
        lineDiagnostics.push({ lineNumber: line.lineNumber, action: "kept", ruleId: "rule.kept", lineBytes: utf8Bytes(line.text) })
      }
      continue
    }
    truncated = true
    removedLines += 1
    removedLineBytes += size
    if (diagnostics) {
      lineDiagnostics.push({
        lineNumber: line.lineNumber,
        action: "dropped",
        ruleId: "rule.truncate.budget",
        lineBytes: utf8Bytes(line.text),
      })
    }
  }
  addNote(notes, "rule.truncate.budget", removedLines, removedLineBytes, diagnostics)

  const text = finalLines.join("\n")
  const status: ReductionStatus =
    errors.length > 0 ? "failed" : finalLines.every((line) => line.trim() === "") ? "empty" : "ok"

  const removedBytes = Math.max(0, originalBytes - utf8Bytes(text))

  return {
    reduceId,
    status,
    text,
    errors,
    warnings: extra.warnings,
    hits: extra.hits,
    duplicatesRemoved,
    originalBytes,
    removedBytes,
    truncated,
    removedLines,
    removedLineBytes,
    notes,
    diagnostics: lineDiagnostics,
  }
}

/**
 * Append the truncation marker. The marker carries the reference so a reader
 * can always walk back to the stored original.
 */
export function renderPlan(plan: ReductionPlan, options: ReductionOptions = {}, originalRef = "local://unavailable"): string {
  if (!plan.truncated) return plan.text
  const explain = options.diagnostics === true || plan.notes.some((note) => note.ruleId === "rule.truncate.budget" && note.explanation !== undefined)
  const reason = explain ? ", error lines preserved by rule.truncate.budget" : ""
  return [
    plan.text,
    `[microtools: truncated ${plan.removedLines} lines / ${plan.removedLineBytes} bytes${reason}, full output: ${originalRef}]`,
  ].join("\n")
}
