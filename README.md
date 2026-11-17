# opencode-local-toolkit

Two independent, offline plugins for the OpenCode terminal. One repository, two
packages, two release cycles — they share a home, not a dependency graph.

![Architecture](docs/architecture.svg)

An interactive version with guided views is in
[`docs/architecture.html`](docs/architecture.html).

## The two plugins

| Package | What it solves | State |
| --- | --- | --- |
| [`plugins/local-dictation`](plugins/local-dictation/README.md) | Talk instead of typing. A microphone button beside the prompt streams a live draft, cleans the audio, and inserts final text only when you press Stop. | Working locally; host and microphone validation pending |
| [`plugins/microtools`](plugins/microtools/README.md) | Fewer tokens per task. Deterministic reducers shrink build, test, terminal and search output before it reaches the model, and every original stays recoverable. | Sprint 1 library; not wired to the host yet |

They are separate on purpose:

- **Different jobs.** Dictation is about latency and recognition. Microtools is
  about context size and token cost. Improving transcription does not itself save
  tokens, and compressing logs does not make speech recognition better.
- **Different maturity.** Dictation has a UI, a native core and a test suite.
  Microtools is an early library with no host hook yet. Keeping separate
  `package.json` files means one can ship a release without dragging the other.
- **No shared code today.** If a shared module ever appears, a workspace can be
  introduced then; inventing one now would be ceremony.

## How dictation flows

`OpenCode` → `TUI plugin` → `Controller` → `Streaming backend` → `FFmpeg` →
`Native core` → hypotheses back to the draft.

- Capture is FFmpeg DirectShow at 16 kHz mono, with a conservative cleanup chain
  (70 Hz high-pass, mild denoise, 0.95 limiter, no automatic gain). It can be
  bypassed with `OPENCODE_ASR_AUDIO=off`.
- Recognition runs in a small native C++ executable speaking a line-based JSON
  protocol; the private Python worker is kept as a fallback.
- Raw PCM is piped, never decoded as text and never written to disk.
- Nothing records until the microphone button is clicked, and nothing is
  submitted automatically.

## Install

Each package has its own instructions:

- [local-dictation install](plugins/local-dictation/docs/install.md) — OpenCode
  2.3.0, Windows x64, FFmpeg, a private Python environment and the Spanish model.
- [microtools README](plugins/microtools/README.md) — library usage and tests.

## Layout

```text
plugins/local-dictation/   OpenCode TUI plugin, native core, worker, tests
plugins/microtools/        Deterministic output reducers and original-output store
docs/                      Shared architecture diagram and its source specification
```

## Status, stated plainly

- Both plugins are experimental; no release has been published.
- The dictation pipeline was proven with one paced synthetic Spanish fixture
  through the real backend: 11 non-empty hypotheses before end of input, and the
  expected transcript. That is not a general accuracy claim, and no automated
  test opens a microphone.
- Running-host behaviour and user-operated microphone validation are still
  pending, and the native review tooling in this environment could not evaluate
  the OpenCode runtime.
- Microtools measured roughly 16% text-size reduction on its own fixture. Text
  size is not tokens, and one fixture is not a benchmark.

## License

Not chosen yet. The Vosk model, FFmpeg, Python and OpenCode each carry their own
licenses; this repository does not redistribute any of them.
