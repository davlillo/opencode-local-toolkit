/**
 * Savings statistics for the Microtools plugin.
 *
 * The server plugin appends one line per successful shrink; the TUI part reads
 * and aggregates it. NDJSON keeps writes append-only and reads resilient to a
 * partially written last line.
 */

import { appendFile, readFile } from "node:fs/promises"

export interface StatsEntry {
  at: string
  tool: string
  reducer: string
  originalBytes: number
  outputBytes: number
  removedBytes: number
  /** Approximate chars/4 estimates; absent in older entries. */
  originalTokens?: number
  outputTokens?: number
}

export interface ReducerStats {
  count: number
  originalBytes: number
  outputBytes: number
  savedBytes: number
  savedTokens: number
}

export interface StatsSummary {
  entries: number
  originalBytes: number
  outputBytes: number
  savedBytes: number
  savedTokens: number
  byReducer: Record<string, ReducerStats>
  lastAt?: string
}

export const EMPTY_SUMMARY: StatsSummary = { entries: 0, originalBytes: 0, outputBytes: 0, savedBytes: 0, savedTokens: 0, byReducer: {} }

function addReducer(summary: StatsSummary, entry: StatsEntry): void {
  const bucket = summary.byReducer[entry.reducer] ?? { count: 0, originalBytes: 0, outputBytes: 0, savedBytes: 0, savedTokens: 0 }
  bucket.count += 1
  bucket.originalBytes += entry.originalBytes
  bucket.outputBytes += entry.outputBytes
  bucket.savedBytes += entry.removedBytes
  bucket.savedTokens += (entry.originalTokens ?? 0) - (entry.outputTokens ?? 0)
  summary.byReducer[entry.reducer] = bucket
}

/** Aggregate NDJSON lines; malformed or partial trailing lines are skipped. */
export function aggregate(content: string): StatsSummary {
  const summary: StatsSummary = { entries: 0, originalBytes: 0, outputBytes: 0, savedBytes: 0, savedTokens: 0, byReducer: {} }
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const value = JSON.parse(trimmed) as Partial<StatsEntry>
      if (typeof value.originalBytes !== "number" || typeof value.outputBytes !== "number"
        || typeof value.removedBytes !== "number" || typeof value.reducer !== "string") continue
      const entry: StatsEntry = {
        at: typeof value.at === "string" ? value.at : "",
        tool: typeof value.tool === "string" ? value.tool : "unknown",
        reducer: value.reducer,
        originalBytes: value.originalBytes,
        outputBytes: value.outputBytes,
        removedBytes: value.removedBytes,
        originalTokens: typeof value.originalTokens === "number" ? value.originalTokens : undefined,
        outputTokens: typeof value.outputTokens === "number" ? value.outputTokens : undefined,
      }
      summary.entries += 1
      summary.originalBytes += entry.originalBytes
      summary.outputBytes += entry.outputBytes
      summary.savedBytes += entry.removedBytes
      summary.savedTokens += (entry.originalTokens ?? 0) - (entry.outputTokens ?? 0)
      addReducer(summary, entry)
      if (entry.at) summary.lastAt = entry.at
    } catch {
      // A torn trailing line stays invisible; the next append starts fresh.
    }
  }
  return summary
}

export async function appendStats(path: string, entry: StatsEntry): Promise<void> {
  await appendFile(path, JSON.stringify(entry) + "\n", "utf8")
}

export async function readStats(path: string): Promise<StatsSummary> {
  try {
    return aggregate(await readFile(path, "utf8"))
  } catch {
    return { ...EMPTY_SUMMARY, byReducer: {} }
  }
}

/** Human byte size, binary units, one decimal; integers stay clean. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  const rounded = unit === 0 ? String(Math.round(value)) : value.toFixed(1)
  return `${rounded} ${units[unit]}`
}

/** Compact token count: 999 stays exact, larger values use k/M. */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0"
  if (tokens < 1000) return String(Math.round(tokens))
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`
  return `${(tokens / 1_000_000).toFixed(1)}M`
}
