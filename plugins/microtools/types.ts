/**
 * Public types for the reduction pipeline. Kept in one small module so the
 * surface stays inspectable.
 */

export type ReducerId = "build" | "test" | "terminal" | "search"

export type ReductionStatus = "ok" | "failed" | "empty" | "unchanged"

export interface ReductionOptions {
  diagnostics?: boolean
  /** Emitted-text budget in UTF-8 bytes. Error lines are exempt. */
  maxOutputBytes?: number
}

export interface StoreOptions {
  /** Caller-provided directory. Never the plugin source tree. */
  storeDir: string
  maxStoreBytes?: number
}

export interface ReduceOptions extends ReductionOptions, StoreOptions {
  /** Per-reducer switches. Disabled means exact passthrough. */
  enabled?: Partial<Record<ReducerId, boolean>>
}

/** A distinct diagnostic, in first-seen order, with verbatim fields. */
export interface ReductionError {
  file?: string
  line?: number
  code?: string
  message: string
  occurrences: number
  text: string
}

export type RemovalAction = "kept" | "dropped" | "grouped" | "collapsed"

/** Why a line left the output. Carries lengths only, never content. */
export interface LineDiagnostic {
  lineNumber: number
  action: RemovalAction
  ruleId: string
  lineBytes: number
}

export interface ReductionNote {
  ruleId: string
  count: number
  removedBytes: number
  /** Present only in diagnostic mode. */
  explanation?: string
}

export interface PlannedLine {
  text: string
  isError: boolean
  lineNumber: number
}

export interface ReductionPlan {
  reduceId: ReducerId
  status: ReductionStatus
  text: string
  errors: ReductionError[]
  warnings: number
  hits: number
  duplicatesRemoved: number
  originalBytes: number
  removedBytes: number
  truncated: boolean
  removedLines: number
  removedLineBytes: number
  notes: ReductionNote[]
  diagnostics: LineDiagnostic[]
}

export interface TokenEstimate {
  value: number
  approximate: true
  basis: "chars/4"
  note: string
}

/** Every result points at its original. There is no ref-free variant. */
export interface ReductionResult {
  reduceId: ReducerId
  status: ReductionStatus
  text: string
  errors: ReductionError[]
  warnings: number
  hits: number
  duplicatesRemoved: number
  originalBytes: number
  outputBytes: number
  removedBytes: number
  removedLines: number
  originalRef: string
  truncated: boolean
  tokens: TokenEstimate
  notes: ReductionNote[]
  diagnostics: LineDiagnostic[]
}
