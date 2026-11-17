/**
 * OpenCode Microtools - Sprint 1 public surface.
 *
 * This is a library, not a host plugin: Sprint 1 does not call any OpenCode
 * host API. `reduceOutput` is the single entry point a hook would call.
 */

import { DEFAULT_MAX_OUTPUT_BYTES, planReduction, renderPlan } from "./reducers.ts"
import { putOriginal } from "./store.ts"
import { TOKENS_NOTE, estimateTokens, utf8Bytes } from "./text.ts"
import type { ReduceOptions, ReductionResult, ReducerId, TokenEstimate } from "./types.ts"

export const REDUCER_IDS: readonly ReducerId[] = ["build", "test", "terminal", "search"]

export { detectReducer, planReduction, renderPlan } from "./reducers.ts"
export {
  DEFAULT_MAX_STORE_BYTES,
  OriginalOutputTooLargeError,
  REF_PREFIX,
  UnknownReferenceError,
  isOriginalRef,
  originalRefFor,
  resolveOriginal,
} from "./store.ts"
export { TOKENS_NOTE, estimateTokens, stripAnsi, utf8Bytes } from "./text.ts"
export type * from "./types.ts"

function isEnabled(reduceId: ReducerId, options: ReduceOptions): boolean {
  const flag = options.enabled?.[reduceId]
  return flag !== false
}

function tokens(text: string): TokenEstimate {
  return { value: estimateTokens(text), approximate: true, basis: "chars/4", note: TOKENS_NOTE }
}

/**
 * Reduce a tool result and store its complete original.
 *
 * Order matters for the no-silent-loss guarantee: the original is stored
 * before any reduced text is returned, so every result has a live reference.
 */
export async function reduceOutput(
  reduceId: ReducerId,
  rawText: string,
  options: ReduceOptions,
): Promise<ReductionResult> {
  if (!REDUCER_IDS.includes(reduceId)) {
    throw new Error(`Unknown reducer "${reduceId}". Expected one of: ${REDUCER_IDS.join(", ")}.`)
  }
  if (typeof rawText !== "string") throw new Error("rawText must be a string.")
  if (options.maxOutputBytes !== undefined && !(options.maxOutputBytes >= 1)) {
    throw new Error("maxOutputBytes must be a positive byte count.")
  }

  const originalRef = await putOriginal(rawText, options)
  const originalBytes = utf8Bytes(rawText)

  if (!isEnabled(reduceId, options)) {
    const note = {
      ruleId: "rule.reducer.disabled",
      count: 1,
      removedBytes: 0,
      ...(options.diagnostics === true
        ? { explanation: "The reducer is disabled, so the text passes through unchanged." }
        : {}),
    }
    return {
      reduceId,
      status: "unchanged",
      text: rawText,
      errors: [],
      warnings: 0,
      hits: 0,
      duplicatesRemoved: 0,
      originalBytes,
      outputBytes: originalBytes,
      removedBytes: 0,
      removedLines: 0,
      originalRef,
      truncated: false,
      tokens: tokens(rawText),
      notes: [note],
      diagnostics: [],
    }
  }

  const plan = planReduction(reduceId, rawText, {
    diagnostics: options.diagnostics,
    maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
  })
  const text = renderPlan(plan, { diagnostics: options.diagnostics }, originalRef)
  const outputBytes = utf8Bytes(text)

  return {
    reduceId,
    status: plan.status,
    text,
    errors: plan.errors,
    warnings: plan.warnings,
    hits: plan.hits,
    duplicatesRemoved: plan.duplicatesRemoved,
    originalBytes,
    outputBytes,
    removedBytes: Math.max(0, originalBytes - outputBytes),
    removedLines: plan.removedLines,
    originalRef,
    truncated: plan.truncated,
    tokens: tokens(text),
    notes: plan.notes,
    diagnostics: plan.diagnostics,
  }
}
