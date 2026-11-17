# Install local terminal dictation

This is an experimental Windows x64 plugin for **OpenCode 2.3.0 only**.
Other host versions intentionally leave it inactive. Installing source does not
install the recognizer or prove that your microphone works.

## Prerequisites

| Component | Validated version | Purpose |
| --- | --- | --- |
| OpenCode | 2.3.0 | Terminal host and runtime plugin SDK |
| Bun | 1.3.14 | Development tests; use the host's SDK at runtime |
| Python x64 | 3.11.0 | Private Vosk worker environment |
| FFmpeg | 8.1.1 | DirectShow capture and audio filtering |
| Vosk | 0.3.45 | Offline streaming recognition |
| Spanish model | `vosk-model-small-es-0.42` | Explicit local model; about 38 MiB download |

The source does not bundle or redistribute Python, FFmpeg, models or environments.
Obtain each dependency from its publisher and review its separate license.

The preferred worker is a small native C++ executable built from `native/`
(requires MSVC x64 Build Tools and CMake):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File native\build.ps1
```

It copies `libvosk.dll` next to the built executable at build time and stays out
of the source tree (`native/build/` is ignored). Without it the plugin falls back
to the private Python environment below.

## Load the source

Place the complete source package in a new directory named `local-dictation`
under the OpenCode global configuration directory's `plugins` directory. Keep
`package.json`, `tui.tsx`, the TypeScript modules and `vosk-worker.py` together.
Do not overwrite an existing installation without preserving it first.

OpenCode discovers this package layout and resolves `@opencode/plugin/tui`
itself; do not install a duplicate host SDK into global configuration.
Use `/reload` after installation. A restart is not required.

Alternatively, add this directory's absolute path to `plugins` in your existing
global `cli.json`, preserving all other entries. Do not put terminal-only
configuration in `opencode.json`.

Official references: [plugin loading](https://opencode.ai/docs/cli/plugins/) and
[TUI plugins](https://opencode.ai/docs/build/plugins/cli/).

## Provision the recognizer separately

The default locations are:

```text
%LOCALAPPDATA%\opencode-asr\venv-vosk\Scripts\python.exe
%LOCALAPPDATA%\opencode-asr\models\vosk-model-small-es-0.42\
```

Create the private Python 3.11 environment only if it does not already exist.
The lock in this source tree contains the artifact hashes verified during the
original Windows x64 / Python 3.11 provisioning:

```powershell
$asr = Join-Path $env:LOCALAPPDATA "opencode-asr"
py -3.11 -B -m venv (Join-Path $asr "venv-vosk")
$python = Join-Path $asr "venv-vosk\Scripts\python.exe"
& $python -B -m pip install --require-hashes --no-deps --no-build-isolation -r .\requirements-vosk.lock
& $python -B -m pip check
```

These commands access the public package registry. The documented installation
has not been repeated in a clean machine during the audio-pipeline revision.
The lock includes an `srt` source archive; its build needs the environment's
setuptools. Do not remove hash checking or silently upgrade packages if
installation fails. A matching preverified offline wheelhouse is preferable.
No automatic download or installation runs from the plugin.

Download the model from the [official model catalog](https://alphacephei.com/vosk/models).
The original archive is
[`vosk-model-small-es-0.42.zip`](https://alphacephei.com/vosk/models/vosk-model-small-es-0.42.zip).
Before extracting it into the `models` directory, verify:

| Check | Expected value | Provenance |
| --- | --- | --- |
| Archive size | 39,817,833 bytes | Original verified download |
| MD5 | `2d5c94f9859a84881a0ef744738ebd31` | Publisher catalog |
| SHA-256 | `09b239888f633ef2f0b4e09736e3d9936acfd810bc65d53fad45261762c6511f` | Locally computed during original provisioning |

MD5 detects corruption but is not strong authenticity proof; the locally
computed SHA-256 is not a publisher signature. Use HTTPS and the official source.
Extract only the expected model directory; do not overwrite unrelated files.
The worker uses an explicit local path, never Vosk's automatic model-name download.

## Select FFmpeg and test manually

Make FFmpeg available on `PATH`, or set `OPENCODE_ASR_FFMPEG` to its executable.
`OPENCODE_ASR_DEVICE` optionally selects an exact DirectShow device name.
If multiple devices are found, the plugin asks you to select one.

Focus the normal prompt without a selection, click **Mic Record**, speak,
then click **Mic Stop**. The draft is separate from the prompt. Review the
inserted text and submit it yourself. **Cancel** discards the recording.

Only this user-operated trial opens the microphone. Unit tests, source loading,
documentation checks and dependency installation do not.
