# Local dictation for the OpenCode terminal

**Status: experimental.** The timeout cleanup defect (B1) is fixed and covered by
deterministic lifecycle tests; the default worker is now a small native C++ core,
with the private Python venv kept as fallback. Running-host and user-microphone
validation remain pending, and no native review approval exists.

Windows-only, offline Spanish streaming dictation using FFmpeg and Vosk.
A microphone button controls recording. Replaceable hypotheses appear in a live
draft while you speak; finalized text enters the editable prompt only after Stop.
The plugin never submits a prompt, uses the clipboard, or records automatically.

For another machine, follow [installation and runtime prerequisites](docs/install.md).
For a source release, use the [publication checklist and allowlist](docs/publishing.md).
The [model reference](docs/models.md) lists verified sizes, licenses and limits.
No source license or GitHub destination has been selected yet.

## Use

Run `/reload` once if the microphone control has not appeared yet.

1. Focus the normal prompt, without a text selection.
2. Click **Mic Record** beside the prompt.
3. Choose a microphone if more than one is available, then speak.
4. Watch the live draft, then click **Mic Stop**.
5. Review and edit the inserted text, then send it yourself.

Click **Cancel** to discard recording or recognition. Recording stops automatically
after 60 seconds. No default hotkey is claimed; existing shortcuts stay unchanged.
The session composer shows a bounded preview; Home shows a compact footer draft.
Partial hypotheses replace each other rather than appending duplicate words.

Slash/palette controls remain available as optional compatibility controls:

| Command | Effect |
| --- | --- |
| `/dictate` | Start recording, or stop and transcribe the current recording. |
| `/dictate-stop` | Stop recording and flush the final result, without starting a new recording. |
| `/dictate-cancel` | Cancel recording/inference and discard pending text. |
| `/dictate-insert` | Explicitly insert a pending transcript in its original session. |

If focus, editor, session, location, selection, or shell mode changes, automatic
insertion is refused and the transcript stays in memory. Return to the original
session, focus the normal prompt, and click **Insert**. The optional
`/dictate-insert` command performs the same guarded recovery. Drafts are hidden
immediately in another session/location without waiting for another ASR event.

## Runtime and privacy

- Supported host: **OpenCode 2.3.0**. Other versions leave this plugin inactive.
  It uses public OpenTUI editor methods and the host's version-specific prompt traits;
  there is no stable dedicated composer API.
- Engine: a small native C++ core (`native/build/dictation-core.exe`, built with
  MSVC x64 from `native/`) that denoises, recognizes and emits the same streaming
  protocol. It loads `libvosk.dll` dynamically; see [the native core](docs/native-core.md).
  When the executable is absent, the plugin falls back to Vosk 0.3.45 in
  `%LOCALAPPDATA%\opencode-asr\venv-vosk`.
- Audio cleanup before recognition: 70 Hz high-pass, mild fixed denoise and a
  0.95 limiter with automatic level disabled; `OPENCODE_ASR_AUDIO=off` bypasses it
  and `OPENCODE_ASR_HUM_HZ=50|60` adds an explicit notch. See
  [the audio pipeline](docs/audio-pipeline.md) for measured results.
- Model: `%LOCALAPPDATA%\opencode-asr\models\vosk-model-small-es-0.42`;
  approximately 38 MiB download, Apache-2.0 according to the official catalog.
- `vosk-manifest.json` records pinned Python dependencies and artifact hashes.
  The model's publisher MD5 was verified; its SHA-256 is locally computed, not
  represented as a publisher-authenticated SHA-256.
- FFmpeg must remain on PATH. `OPENCODE_ASR_FFMPEG` can override its executable;
  `OPENCODE_ASR_DEVICE` can specify an exact DirectShow audio-device name.
- The model loads from an explicit local path before capture starts. There is no
  model-name lookup, cloud ASR, API key, or GPU requirement.
- TypeScript owns FFmpeg and the unbuffered Python worker. Raw mono PCM16LE
  at 16 kHz flows through a backpressured pipe, never through a UTF-8 decoder.
- The default streaming path keeps audio in pipes, not recording files. Stop drains
  audio and flushes recognition; cancellation terminates both owned processes and
  treats process death, not stdio flushing, as the close signal.
- Python fallback launches explicitly use Python `-B`; no bytecode cache is required.
- No network access occurs during recording or inference. Recognized text is sent
  to the selected OpenCode model only if you submit the prompt yourself.

## Verification and known limits

From this directory:

```powershell
bun run test
bun run test:worker
```

The full Bun suite currently passes 63 tests across 9 files, plus 2 Python
worker-protocol tests. Unit tests cover lifecycle, cancellation, late
drafts/results, bounded protocol, raw synthetic capture pipes, preserving text,
target guards and registered commands. They do not access a microphone.

Native control tests use byte-identical source in an isolated harness pinned to
OpenTUI Core/Solid 0.8.4 and solid-js 1.9.17, not the older global cache:

```powershell
bun test --preload @opentui/solid/preload ./controls.test.tsx --timeout 30000 --no-env-file
```

This command belongs in that matching harness, not an arbitrary dependency tree.
The actual controls passed four native tests (24 assertions): click start/stop,
focus/selection preservation, live replacement, route/location hiding, pending
insertion, resize and drag-out handling. This is not running-OpenCode proof.

### Observed native streaming

Two actual decodes used the same paced 6.225-second synthetic Spanish fixture.
With the Python worker the product backend produced 11 nonempty hypotheses before
Stop/EOF, first at about 811 ms from capture readiness, final flush about 142 ms.
With the native C++ core behind the same backend the same fixture also produced
11 nonempty hypotheses and the identical final text; cold start to ready measured
about 1.8 s native versus 3.9 s Python on this machine. The five checked words,
including "dictado", were present in both. Output is lowercase without
punctuation. These are single synthetic runs, not a general accuracy or
live-microphone latency guarantee.

### Preserved limitations

- The native core's termination wait uses process exit as its close signal; actual
  OS-level reaping by PID was not independently inspected.
- Running-host layout and user-operated microphone validation remain pending.
- The streaming backend's real-subprocess suite now passes, including abort,
  stalled-flush and late-output cases, under deterministic injected handles.
- An isolated typecheck and native review assessment were previously unavailable.
  The installed review command refused required `--escalate-item` and returned
  `high/unassessable`. A current plain assessment also returned high/unassessable
  because this installed native build does not admit the OpenCode runtime.
  Review mode was not disabled; no native review approval was produced.
- Provisioning's early Python `-I` calls ignored environment bytecode overrides.
  A fresh audit found no sampled cache timestamps in that provisioning window and
  no evidenced source/config mutation, but no pre-provision baseline proves absence.
- Legacy Whisper assets and their manifest are retained unchanged. Its historical
  synthetic check failed “dictado” -> “dedicado”; that has not been rewritten as PASS.
- The earlier Whisper installer failed an unused optional evidence-sidecar write
  after installation. It was not silently rerun or reported as a successful exit.
