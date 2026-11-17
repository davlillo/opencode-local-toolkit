/**
 * Host adapter for the Microtools plugin.
 *
 * Kept separate from index.ts (pure library) and plugin.ts (host wiring) so the
 * decision logic is testable without the OpenCode runtime. Every function here
 * is deterministic and never throws into the host.
 */

import { detectReducer, reduceOutput } from "./index.ts"
import type { ReducerId } from "./types.ts"

/** Default: only shrink results that actually cost context. */
export const DEFAULT_THRESHOLD_BYTES = 8_192

export interface ToolResultLike {
  content?: unknown
  metadata?: unknown
  [key: string]: unknown
}

export interface CompletedToolEvent {
  tool: string
  sessionID?: string
  status: "completed" | "error"
  result?: ToolResultLike
  [key: string]: unknown
}

export interface ShrinkDeps {
  storeDir: string
  thresholdBytes?: number
  maxOutputBytes?: number
  enabled?: Partial<Record<ReducerId, boolean>>
  onError?: (error: unknown) => void
}

/** Tool name to reducer family. Bash stays content-detected on purpose: it can
 * emit build, test, search or plain logs depending on the command. */
const TOOL_REDUCERS: Record<string, ReducerId> = {
  grep: "search",
  search: "search",
  build: "build",
  test: "test",
}

function textOf(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    if (record.type === "text" && typeof record.text === "string") return record.text
  }
  return undefined
}

/**
 * Read the textual parts of a tool result without assuming one shape.
 * Returns the concatenated text and a writer that puts new text back in place.
 */
export function readResultText(result: ToolResultLike): { text: string; write(next: string): boolean } | undefined {
  const content = result.content
  if (typeof content === "string") {
    return { text: content, write: (next) => { result.content = next; return true } }
  }
  if (Array.isArray(content)) {
    const texts = content.map(textOf)
    if (texts.every((part): part is string => part !== undefined)) {
      const joined = texts.join("\n")
      return {
        text: joined,
        write: (next) => {
          // A single text part keeps the original shape; multiple parts are merged.
          if (content.length === 1) (content[0] as Record<string, unknown>).text = next
          else result.content = [{ type: "text", text: next }]
          return true
        },
      }
    }
  }
  return undefined
}

export function reducerForTool(tool: string, text: string): ReducerId {
  const named = TOOL_REDUCERS[tool.toLowerCase()]
  return named ?? detectReducer(text)
}

/**
 * Build the `execute.after` handler. It shrinks a completed tool result in
 * place and stores the original; anything unexpected leaves the result intact.
 */
export function createShrinkHandler(deps: ShrinkDeps) {
  const threshold = deps.thresholdBytes ?? DEFAULT_THRESHOLD_BYTES
  const report = deps.onError ?? (() => {})

  return async function shrink(event: CompletedToolEvent): Promise<void> {
    try {
      if (event.status !== "completed" || !event.result) return
      const parts = readResultText(event.result)
      if (!parts) return
      const bytes = new TextEncoder().encode(parts.text).length
      if (bytes < threshold) return

      const reduced = await reduceOutput(reducerForTool(event.tool, parts.text), parts.text, {
        storeDir: deps.storeDir,
        maxOutputBytes: deps.maxOutputBytes,
        enabled: deps.enabled,
      })
      if (reduced.removedBytes <= 0 || reduced.text === parts.text) return
      if (!parts.write(reduced.text)) return

      // Metadata is additive and never replaces host fields.
      if (event.result.metadata && typeof event.result.metadata === "object") {
        const metadata = event.result.metadata as Record<string, unknown>
        metadata.microtools = {
          reducer: reduced.reduceId,
          originalBytes: reduced.originalBytes,
          outputBytes: reduced.outputBytes,
          removedBytes: reduced.removedBytes,
          originalRef: reduced.originalRef,
        }
      }
    } catch (error) {
      report(error)
    }
  }
}
