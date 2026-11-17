# OpenCode Microtools

Local, deterministic reduction of tool output before it reaches the model
context. No network, no cloud API, no model call, no token spent on optimizing.

**Status: a real OpenCode plugin (server side).** It registers the
`execute.after` tool hook and shrinks completed tool results in place, keeping
every original recoverable. The reduction core is still usable as a library.

## How it connects

```text
tool finishes → execute.after hook → reducer → result.content replaced
                                             → original stored and referenced
                                             → metadata.microtools records the delta
```

- Only completed results are touched; errors pass through untouched.
- Only results at or above `OPENCODE_MICROTOOLS_THRESHOLD` bytes (default 8192)
  are considered, so trivial output is never rewritten.
- `bash`/`shell` are classified by content (build, test, search or plain logs)
  rather than assumed; `grep`/`search`, `build` and `test` map directly.
- If anything fails — the store, the reducer, an unexpected result shape — the
  original result is left exactly as the host produced it.

## Seeing the savings

- The prompt footer shows a cumulative chip like `MT −27.5 KB` once anything
  has been compacted. It refreshes every few seconds.
- The slash command **`/microtools`** (or its palette entry) shows a detail
  toast: how many results were compacted, the before/after sizes and the
  top reducer.
- The raw ledger is `stats.ndjson` next to the store — one line per shrink
  with timestamps, tool, reducer and byte counts. Delete it to restart the
  counters; it is a display aid, not a source of truth for recognition.

## Configuration

| Variable | Meaning |
| --- | --- |
| `OPENCODE_MICROTOOLS_DIR` | Directory for stored originals. Defaults to `%LOCALAPPDATA%\opencode-microtools\originals`. |
| `OPENCODE_MICROTOOLS_THRESHOLD` | Minimum UTF-8 bytes before a result is considered. |
| `OPENCODE_MICROTOOLS_BUILD` / `_TEST` / `_TERMINAL` / `_SEARCH` | Set to `off` to disable one reducer. |

No config file is read, and no global setting is modified.

## What the reduction core does

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

## What it does not do

- No UI, no spans/traces reconstruction, no streaming reducer, and no
  cross-result deduplication (that is the state-cache work in later sprints).
- No retention policy or garbage collection for the store.
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
