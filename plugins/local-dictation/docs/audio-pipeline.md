# Conservative streaming audio cleanup

`audio-pipeline.ts` resolves two typed controls into a fixed FFmpeg filter chain.
It does not capture audio, launch processes, store recordings, change transcripts,
or choose a recognizer. Cleanup runs inside the existing capture process when
the caller adds its output-side filter arguments.

## Configuration

| Variable | Default | Accepted values |
| --- | --- | --- |
| `OPENCODE_ASR_AUDIO` | `clean` | `clean`, `off` |
| `OPENCODE_ASR_HUM_HZ` | `off` | `off`, `50`, `60` |

Values are exact and case-sensitive. Empty strings, whitespace, automatic hum
selection, and arbitrary filter text are rejected with a static English error.
Both controls are validated even in bypass mode; error messages do not echo
configuration values or enumerate the environment. No hum frequency is inferred
from language or location.

`off` returns no cleanup arguments, including when a valid hum choice is present.
The caller must still keep its mono, 16 kHz, PCM16LE output format.

## Integration seam

The complete public API is:

```ts
export interface AudioPipelineSettings {
  mode: "clean" | "off"
  humHz?: 50 | 60
}

export declare function resolveAudioPipeline(environment?: {
  OPENCODE_ASR_AUDIO?: string
  OPENCODE_ASR_HUM_HZ?: string
}): AudioPipelineSettings // defaults to process.env

export declare function audioFilterArgs(settings: AudioPipelineSettings): string[]
```

Resolve and validate before device discovery or starting capture/recognition.
For example, in the existing capture argument builder:

```ts
import { audioFilterArgs, resolveAudioPipeline } from "./audio-pipeline"

const audio = resolveAudioPipeline()
const args = [
  "-hide_banner", "-f", "dshow", "-i", `audio=${device}`,
  ...audioFilterArgs(audio),
  "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1",
]
```

`device` remains the existing explicitly selected device. This example does not
start capture; the existing caller retains its duration, cancellation, readiness,
and final-flush controls. Direct settings objects are also runtime-validated.

## Fixed profile and tradeoffs

1. `aformat=sample_fmts=fltp:sample_rates=16000:channel_layouts=mono` supplies
   mono floating-point audio at the recognizer's 16 kHz rate.
2. `highpass=f=70:p=2` reduces rumble, but can attenuate low voice fundamentals.
3. An explicit `humHz` inserts `bandreject=f=50:t=h:w=2` or its 60 Hz equivalent.
   The narrow 2 Hz notch can also remove desired energy at that frequency.
4. `afftdn=nr=6:nf=-50:tn=0` applies mild FFT denoising without automatic noise
   tracking. Quiet noise-like consonants can be weakened; this is not a gate.
5. `alimiter=limit=0.95:level=0:attack=5:release=50:latency=1` limits peaks without
   automatic makeup gain. It uses 5 ms lookahead and compensates its sample delay
   and EOF drain. It cannot repair audio already clipped at the microphone.

There is no added amplification/AGC, silence removal, aggressive VAD, model,
service, dependency, or production subprocess. FFT buffering and limiter
lookahead still add live latency. Sample-delay compensation is not zero-latency
processing; capture, OS scheduling, pipes and recognition add further delays.

## Deterministic evidence, not speech-accuracy evidence

Run from the plugin directory:

```powershell
bun test ./audio-pipeline.test.ts --timeout 5000 --no-env-file
```

Six pure tests validate configuration and exact arguments. Four separate native
tests process the same finite, seeded 5.8-second synthetic PCM signal through
FFmpeg: silence margins, noise, voiced harmonics, first/last consonant-like
bursts, unclipped loud peaks, and explicit 50/60 Hz tones. No microphone,
recognizer, user audio or audio files are involved.

Each native call uses finite stdin, no shell, a 1.5-second timeout and a 1 MiB
output bound. It selects `OPENCODE_ASR_FFMPEG` or the `ffmpeg` command. Missing
FFmpeg explicitly skips native tests; passing pure tests is not native proof.
Other execution errors fail the native checks.

Budgets were fixed before the first DSP run; the original candidate met them
without threshold relaxation:

| Measure | Fixed budget | Observed clean result |
| --- | --- | --- |
| Noise-only RMS attenuation | at least 1 dB | 6.036 dB |
| Voiced RMS change | within +/-3 dB | -0.050 dB |
| Positive voiced correlation | at least 0.8 | 0.897 |
| PCM16 output peak | at most 0.96 | 0.950012 |
| Output sample count | exactly 92,800 | 92,800 |
| First-burst alignment | at most 800 samples / 50 ms | 400 samples / 25 ms |
| Aligned first-burst correlation | at least 0.8 | 0.988 |
| First / last burst RMS change | each within +/-3 dB | -0.311 / -0.312 dB |
| Extra 50 / 60 Hz notch attenuation | each at least 6 dB | 34.091 / 33.654 dB |

Alignment is searched against the broadband first burst within the fixed bound.
Hum attenuation compares each notched profile against the same clean profile
without a notch, so high-pass rejection is not credited to the notch.
Bypass was also byte-for-byte identical to the input.

These results establish only synthetic signal behavior for this local FFmpeg.
They do not establish word-error rate, real quiet-consonant retention, live
end-to-end latency, microphone quality, cancellation correctness, or native host
compatibility. Real-speech accuracy must be measured separately with consent;
the candidate is not a promise of improved transcription.

Filter references: [highpass](https://ffmpeg.org/ffmpeg-filters.html#highpass),
[bandreject](https://ffmpeg.org/ffmpeg-filters.html#bandreject),
[afftdn](https://ffmpeg.org/ffmpeg-filters.html#afftdn), and
[alimiter](https://ffmpeg.org/ffmpeg-filters.html#alimiter).
