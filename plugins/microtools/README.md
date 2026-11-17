# OpenCode Microtools — Sprint 1 (reduction core)

Local, deterministic reduction of tool output before it reaches the model
context. No network, no cloud API, no model call, no token spent on optimizing.

**Status: this is a library, not yet an OpenCode host plugin.** Sprint 1 does
not register hooks, does not read `opencode.json`, and does not know how
OpenCode delivers tool results. `reduceOutput()` is the single call a future
hook would make; wiring is Sprint 2+.

## What Sprint 1 does

- Four pure reducers: `build`, `test`, `terminal`, `search`.
- Collapses exact duplicate lines with a counter.
- Collapses consecutive progress/spinner/percentage lines.
- Groups identical diagnostics with an occurrence count, keeping file, line,
  error code and message verbatim.
- Truncates oversized output behind an explicit marker, never truncating error
  lines.
- Stores every complete original (lossless, content-hash keyed) and returns a
  `local://logs/<sha256>` reference on every result.
- Explanatory diagnostics: rule ids and counts always, per-line reasons and
  human explanations when `diagnostics: true`.
- Approximate token estimate, explicitly labelled `chars/4`.

## What Sprint 1 does not do

- No host hook, no automatic interception, no config loading, no UI.
- No spans/traces reconstruction, no streaming reducer, no cross-result
  deduplication (that is the state-cache work in later sprints).
- No retention policy or garbage collection for the store (caller's directory).
- The token figure is an estimate, never a provider token count.

## Usage

```ts
import { reduceOutput, resolveOriginal, detectReducer } from "./index.ts"

const result = await reduceOutput("build", rawToolOutput, {
  storeDir: "C:/Users/me/AppData/Local/Temp/opencode/microtools-logs",
  maxOutputBytes: 4096,      // emitted text budget, error lines exempt
  maxStoreBytes: 8 << 20,    // hard bound, throws before writing
  enabled: { search: false },// per-reducer switches
  diagnostics: true,         // explain every removal
})

result.text            // compact text for the context
result.originalRef     // local://logs/<sha256>
result.removedBytes    // what left the output
const original = await resolveOriginal(result.originalRef, { storeDir })
```

`storeDir` is required and must point outside this source tree.

## Rules

| Rule id | Effect |
| --- | --- |
| `rule.ansi.strip` | Escape sequences removed, printable text kept |
| `rule.progress.collapse` | Consecutive progress run folded to its last line |
| `rule.error.group` | Identical diagnostics grouped, fields verbatim |
| `rule.duplicate.collapse` | Exact duplicates folded into the first occurrence |
| `rule.blank.collapse` | Blank line runs and trailing blanks folded |
| `rule.truncate.budget` | Non-error lines dropped past `maxOutputBytes` |
| `rule.reducer.disabled` | Passthrough, `status: "unchanged"` |

Every reduction is recorded in `notes` with a count and removed byte size, so a
later UI can say why content disappeared. Notes carry lengths only, never
content.

## Guarantees

1. **No silent loss.** Every result carries `originalRef` plus `removedBytes`
   and `removedLines`. The original is stored *before* reduced text is returned,
   so a store failure throws instead of yielding an unrecoverable result.
2. **Lossless, verified recovery.** `resolveOriginal` re-hashes the payload and
   rejects a tampered or missing file.
3. **Errors are never truncated.** Error lines bypass the byte budget.
4. **Store bound is loud.** Over `maxStoreBytes` throws
   `OriginalOutputTooLargeError` with the size and the limit.
5. **No source-tree writes.** The store only touches `storeDir`.
6. **Per-reducer disable.** A disabled reducer returns the input byte for byte.
7. **Deterministic.** Pure functions; no clock, randomness, or environment.
8. **No double summarization.** Re-reducing an already reduced text finds no
   duplicates (covered by test).
9. **Secrets stay local.** Diagnostics describe sizes and counts, not content.

## Known limits

- Grouping is keyed on the exact diagnostic text; the same error at two
  different lines stays two entries (intentional).
- Reducers recognize common `tsc`, cargo, vitest/jest and `path:line:` shapes.
  Unrecognized output still gets ANSI, duplicate, progress and truncation
  handling.
- Truncation drops from the tail, so late non-error context is preferred lost
  over early errors. Order is stable, never shuffled.

## Tests

```sh
bun test ./ --no-env-file
```

Fixtures are generated inline; nothing binary is committed. Tests cover every
rule above plus byte-exact round-trip recovery.
