# Models for local dictation and Microtools

Verified against primary sources on 2026-11-17. Sizes are the artifacts actually
published, not roundups. Nothing here is bundled with this plugin.

## Speech recognition

| Model | Artifact | Size | Streaming | License | Notes |
| --- | --- | --- | --- | --- | --- |
| Vosk small Spanish | `vosk-model-small-es-0.42` | 39,817,833 B archive | Native partials | Apache-2.0 | **In use.** Explicit local path; no auto-download. |
| Whistle | `whistle.cact` (Cactus Compute) | 16,919,407 B | Native (`cactus.stream()`) | Apache-2.0 | 55M params, 16 kHz mono, Spanish + English, CPU-only. Needs the Cactus runtime. |
| Whisper base (whisper.cpp) | `ggml-base.bin` | 142 MiB | **No** — chunked re-inference | MIT (code) | Accuracy fallback for hard fragments, not a live streaming engine. `q5_1` is ~57 MiB. |

Whistle is the interesting candidate: it is genuinely small, has a native
partial-output API, and covers Spanish. Its error rates are **vendor-reported**
and not independently replicated here, and meeting-style audio is weak. Switching
to it would add the Cactus runtime as a second native dependency, so it stays a
candidate until measured against this pipeline.

Whisper base cannot be described as "16 MB". No such base model exists; the
published `ggml-base.bin` is 142 MiB, about 8.7x Whistle.

## Voice activity and noise suppression

| Component | Artifact | Size | License | Notes |
| --- | --- | --- | --- | --- |
| Silero VAD | `silero_vad.onnx` | 2,327,524 B (1.2 MB at 16 kHz) | MIT | Real ONNX; callable from C/C++ through ONNX Runtime. |
| RNNoise | Xiph C library | Source | BSD-3-Clause | **48 kHz only.** At 16 kHz it needs resampling or a retrain. |

RNNoise is the one to watch: the pipeline runs at 16 kHz, and RNNoise is trained
and wired for 48 kHz. Using it means capturing at 48 kHz and resampling down, or
accepting degraded suppression. The current FFmpeg `afftdn` profile avoids that
problem entirely and was measured at about 6 dB of noise attenuation.

## Text models for Microtools (not speech)

| Model | Size | Role | License |
| --- | --- | --- | --- |
| pico-type | ~9 MB ONNX, 1.5M params | Byte-level content classifier | Apache-2.0 |
| Bekko static v1 slim 32k | 68.8 MB | Embeddings, 1024-d Matryoshka | MIT |
| ms-marco MiniLM-L-6-v2 | 23,200,716 B INT8 | Cross-encoder reranker | Apache-2.0 |
| Needle3 | 35,335,380 B | Tool/function calling | Apache-2.0 |

Three corrections against common summaries:

- **pico-type is not audio.** It classifies raw UTF-8 bytes into content type,
  language and MIME. Useful for routing text, useless for dictation.
- **Needle is not 16 MB today.** The current `needle3.cact` is 35.3 MB, and older
  revisions quoted 14 MB. It is a text tool-caller that pairs with Whistle; it
  does not transcribe.
- **The reranker's canonical name** is `ms-marco-MiniLM-L-6-v2`; only the INT8
  export is 23 MB, FP32 is 91 MB.

## What this means for token savings

Better recognition does not save tokens by itself. Token cost lives in tool
output, repeated file contents and stale history — the Output Reducer and
context-selection work. The speech models above change latency and accuracy, not
the size of the prompt you send afterwards.
