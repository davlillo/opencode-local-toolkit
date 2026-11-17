# Native recognizer core

`native/` builds one Windows x64 executable, `dictation-core.exe`, that replaces
the Python process `vosk-worker.py` while keeping its exact NDJSON contract. The
TypeScript side talks to it unchanged: same arguments, same stdout framing, same
message shapes, same final-flush semantics.

Scope of the replacement is the worker process only. FFmpeg capture, the DSP
filter chain in `audio-pipeline.ts`, the streaming backend lifecycle, and all UI
code are unaffected and still owned by the TypeScript side.

## Protocol (must stay byte-compatible)

One UTF-8 JSON object per line on stdout, raw non-ASCII, flushed per line:

| Message | When |
| --- | --- |
| `{"type":"ready"}` | once, after the model is loaded, before any audio is read |
| `{"type":"partial","text":"<draft>"}` | only when the joined draft text changes |
| `{"type":"final","text":"<transcript>"}` | exactly once, at stdin EOF |
| `{"type":"error","message":"<text>"}` | on failure, then a non-zero exit |

Arguments: `--model <absolute model directory>` (also accepted as `--model=<dir>`).
Audio is raw PCM signed 16-bit little-endian, mono, 16000 Hz, read from stdin in
4000-byte (125 ms) chunks. Because a pipe may split a sample, short reads are
padded to 4000 bytes before decoding; a stream that really ends on an odd byte
count is rejected.

The draft is the whitespace-normalized concatenation of the finalized segments
plus the current partial hypothesis. It is emitted only when the joined text
changes, and an empty draft is never emitted. At EOF `FinalResult` is called and
the combined text is emitted as the single `final`.

## Bounds

Both limits mirror `vosk-worker.py` and are compile-time constants in
`src/main.cpp`:

- `kMaxText = 20000` characters (counted as UTF-8 code points).
- `kMaxAudio = 16000 * 2 * 65` bytes (65 s).

Exceeding either emits an `error` message and exits 1, so a runaway stream cannot
exhaust memory. Finalized segments are kept, not the raw audio.

## libvosk loading

`libvosk.dll` is resolved at runtime with `LoadLibraryExW` and
`LOAD_WITH_ALTERED_SEARCH_PATH` (which also finds its MinGW runtime next to it);
symbols are taken with `GetProcAddress`. No import library is generated. Lookup
order is fixed:

1. the executable's own directory,
2. `DICTATION_CORE_VOSK_DLL` (full DLL path),
3. `%LOCALAPPDATA%\opencode-asr\venv-vosk\Lib\site-packages\vosk`.

When all three fail, the error message names every expected location. The model
directory is always explicit; Vosk's automatic model download is never used, so
`vosk_model_new` receives the given path directly.

`vosk_api.h` is vendored from `alphacephei/vosk-api`, tag `v0.3.45`, path
`src/vosk_api.h`, with only the declarations used here kept.

## Build

The toolchain is not on `PATH`. `build.ps1` locates `vcvars64.bat` through
`vswhere` (with fixed fallbacks) and runs CMake's NMake generator inside that
environment:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File native/build.ps1
```

Output is `native/build/dictation-core.exe`. The build also copies
`libvosk.dll` and its three MinGW runtime DLLs next to the executable. Both the
DLL and `native/build/` stay out of the source tree; `native/build/.gitignore`
ignores everything inside the build directory except itself.

`build.ps1` resolves the DLL from `DICTATION_CORE_VOSK_DLL` or the private
`%LOCALAPPDATA%` install; `-VoskDll <path>` overrides both. If nothing is found
the build still succeeds and warns that the binary then needs the environment
variable at runtime.

## Verification

Deterministic, no microphone:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File native/test-protocol.ps1
```

`test-protocol.ps1` pipes the retained synthetic fixture
(`synthetic-es-helena.pcm`, 199,200 bytes, Spanish phrase about reviewing the
code before sending the message) into the executable and asserts: `ready` first,
exactly one `ready`, at least one non-empty `partial`, exactly one `final` as the
last line, exit code 0, and all five checked words present in the final text
(case-, accent- and punctuation-insensitive). Any failure exits non-zero. The
fixture and model paths are parameters.

### Observed evidence (2026-11-17, one run each)

- Build: `powershell -NoProfile -ExecutionPolicy Bypass -File native/build.ps1`,
  MSVC 19.44.35229 (toolset 14.44.35207), x64 Release, no warnings.
- Fixture check: PASS, 11 non-empty partials, final text
  `esto es una prueba de dictado en español quiero revisar el código antes de enviar el mensaje`.
- Cold start (process start to `ready`) and total wall time on the same fixture
  and machine: native 1787 ms / 1898 ms, Python worker 3863 ms / 4070 ms.
- Zero-byte stdin: `ready`, then `final` with empty text, exit 0, no hang.
- Odd-length stdin (3 bytes): `ready`, then
  `error: Input must contain complete PCM16 samples`, exit 1.

## What this does not prove

- Accuracy is not improved by the port: the recognizer, model and audio path are
  the same. Word results are only a contract check, not a WER measurement.
- One measured run per implementation on one machine is a startup/latency
  observation only, not a benchmark.
- Microphone capture, DSP behavior, cancellation and the TypeScript lifecycle are
  unchanged and unverified here.
- The executable is unsigned and Windows-only (x64).

## Intentional protocol differences

1. An empty draft is never emitted, as specified. The Python worker emits an
   empty `partial` when a draft becomes empty again after having text. The
   TypeScript side accepts both; the specified behavior is the stricter one.
2. Bad arguments produce a JSON `error` message and exit 1. Python's `argparse`
   writes usage text to stderr and exits 2, which the TypeScript side never reads.
