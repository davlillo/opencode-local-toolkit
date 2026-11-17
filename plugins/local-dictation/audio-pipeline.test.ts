import { spawnSync } from "node:child_process"
import { expect, test } from "bun:test"
import { audioFilterArgs, resolveAudioPipeline, type AudioPipelineSettings } from "./audio-pipeline"

const cleanFilter = [
  "aformat=sample_fmts=fltp:sample_rates=16000:channel_layouts=mono",
  "highpass=f=70:p=2",
  "afftdn=nr=6:nf=-50:tn=0",
  "alimiter=limit=0.95:level=0:attack=5:release=50:latency=1",
]

test("defaults to clean audio without a hum notch", () => {
  expect(resolveAudioPipeline({})).toEqual({ mode: "clean" })
})

test("accepts only the explicit clean/off and off/50/60 choices", () => {
  for (const mode of ["clean", "off"] as const) {
    for (const hum of ["off", "50", "60"] as const) {
      expect(resolveAudioPipeline({ OPENCODE_ASR_AUDIO: mode, OPENCODE_ASR_HUM_HZ: hum })).toEqual({
        mode, ...(hum === "off" ? {} : { humHz: hum === "50" ? 50 : 60 }),
      })
    }
  }
})

test("rejects invalid configuration without echoing its value", () => {
  for (const value of ["", "CLEAN", " clean ", "volume=99"]) {
    expect(() => resolveAudioPipeline({ OPENCODE_ASR_AUDIO: value }))
      .toThrow("OPENCODE_ASR_AUDIO must be clean or off.")
  }
  for (const value of ["", "auto", "50.0", "50,volume=99"]) {
    expect(() => resolveAudioPipeline({ OPENCODE_ASR_AUDIO: "off", OPENCODE_ASR_HUM_HZ: value }))
      .toThrow("OPENCODE_ASR_HUM_HZ must be off, 50, or 60.")
  }
})

test("builds the fixed unity-gain profile with only an explicit optional notch", () => {
  expect(audioFilterArgs({ mode: "clean" })).toEqual(["-af", cleanFilter.join(",")])
  for (const humHz of [50, 60] as const) {
    const filters = [...cleanFilter]
    filters.splice(2, 0, `bandreject=f=${humHz}:t=h:w=2`)
    expect(audioFilterArgs({ mode: "clean", humHz })).toEqual(["-af", filters.join(",")])
  }
})

test("off bypasses every cleanup filter even when a valid hum choice exists", () => {
  expect(audioFilterArgs({ mode: "off" })).toEqual([])
  expect(audioFilterArgs({ mode: "off", humHz: 50 })).toEqual([])
  expect(audioFilterArgs({ mode: "off", humHz: 60 })).toEqual([])
})

test("validates runtime settings as well as typed callers", () => {
  for (const settings of [
    { mode: "volume=99" }, { mode: 0 }, { mode: null },
    { mode: "clean", humHz: "50" }, { mode: "off", humHz: 51 }, { mode: "clean", humHz: null },
  ]) {
    expect(() => audioFilterArgs(settings as unknown as AudioPipelineSettings)).toThrow()
  }
  type Environment = NonNullable<Parameters<typeof resolveAudioPipeline>[0]>
  expect(() => resolveAudioPipeline({ OPENCODE_ASR_AUDIO: 0 } as unknown as Environment)).toThrow()
  expect(() => resolveAudioPipeline({ OPENCODE_ASR_HUM_HZ: null } as unknown as Environment)).toThrow()
})

const sampleRate = 16_000
const at = (seconds: number) => Math.round(seconds * sampleRate)
const firstBurst = [at(1.1), at(1.15)] as const
const lastBurst = [at(5.35), at(5.4)] as const
const speechRanges = [[at(1.15), at(1.75)], [at(4.55), at(5.35)]] as const

// Locked before the first DSP run: modest cleanup, no large speech loss, no polarity reversal,
// and no lost stream edges. A 50 ms search bounds FFT buffering/alignment, not wall-clock latency.
const budgets = {
  noiseAttenuationDb: 1, speechEnergyDb: 3, correlation: 0.8, peak: 0.96,
  maxAlignmentSamples: at(0.05), burstEnergyDb: 3, humAttenuationDb: 6,
}

function syntheticPcm(): Buffer {
  const pcm = Buffer.alloc(at(5.8) * 2)
  let seed = 0x5eed1234
  for (let i = 0; i < pcm.length / 2; i++) {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0
    const noise = 2 * seed / 0x1_0000_0000 - 1
    const seconds = i / sampleRate
    let value = seconds >= 0.2 && seconds < 5.4 ? noise * 0.003 : 0
    for (const [start, end, fundamental] of [[1.15, 1.75, 180], [4.55, 5.35, 220]]) {
      if (seconds < start || seconds >= end) continue
      const t = seconds - start
      const envelope = Math.min(1, t / 0.01, (end - seconds) / 0.01)
      const phase = 2 * Math.PI * (fundamental * t + 8 * t * t)
      value += envelope * (0.16 * Math.sin(phase) + 0.07 * Math.sin(2 * phase) + 0.035 * Math.sin(3 * phase))
    }
    for (const [start, end] of [firstBurst, lastBurst]) {
      if (i >= start && i < end) value += noise * 0.07 * Math.sin(2 * Math.PI * 3_200 * seconds)
    }
    if (seconds >= 2 && seconds < 2.2) value += 0.99 * Math.sin(2 * Math.PI * 880 * seconds)
    if (seconds >= 2.4 && seconds < 3.2) value += 0.035 * Math.sin(2 * Math.PI * 50 * seconds)
    if (seconds >= 3.4 && seconds < 4.2) value += 0.035 * Math.sin(2 * Math.PI * 60 * seconds)
    // The generated input is never clipped; the loud segment exercises the limiter.
    if (Math.abs(value) >= 1) throw new Error("Synthetic input unexpectedly clips.")
    pcm.writeInt16LE(Math.round(value * 32_767), i * 2)
  }
  return pcm
}

function samples(pcm: Buffer): Float64Array {
  if (pcm.length % 2) throw new Error("FFmpeg returned an incomplete PCM16 sample.")
  return Float64Array.from({ length: pcm.length / 2 }, (_, i) => pcm.readInt16LE(i * 2) / 32_768)
}

const input = syntheticPcm()
const source = samples(input)
const ffmpeg = process.env.OPENCODE_ASR_FFMPEG ?? "ffmpeg"
function runFfmpeg(settings: AudioPipelineSettings) {
  return spawnSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-f", "s16le", "-ar", String(sampleRate), "-ac", "1", "-i", "pipe:0",
    ...audioFilterArgs(settings),
    "-ar", String(sampleRate), "-ac", "1", "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1",
  ], { input, timeout: 1_500, maxBuffer: 1_048_576, windowsHide: true, shell: false })
}

const bypass = runFfmpeg({ mode: "off" })
const ffmpegMissing = (bypass.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
const nativeTest = ffmpegMissing ? test.skip : test
if (ffmpegMissing) {
  console.warn("SKIP native FFmpeg DSP: executable unavailable. Pure filter tests are not native-processing proof.")
}

function output(result: ReturnType<typeof runFfmpeg>): Float64Array {
  if (result.error) throw new Error("Native FFmpeg DSP could not run.", { cause: result.error })
  if (result.status !== 0) throw new Error(`Native FFmpeg DSP failed: ${result.stderr.toString().slice(-1_200)}`)
  return samples(result.stdout)
}

function rms(values: Float64Array): number {
  return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length)
}

function energyDb(reference: Float64Array, actual: Float64Array): number {
  return 20 * Math.log10(rms(actual) / rms(reference))
}

function peak(values: Float64Array): number {
  return values.reduce((highest, value) => Math.max(highest, Math.abs(value)), 0)
}

function correlation(reference: Float64Array, actual: Float64Array): number {
  let dot = 0, left = 0, right = 0
  for (let i = 0; i < reference.length; i++) {
    dot += reference[i] * actual[i]
    left += reference[i] ** 2
    right += actual[i] ** 2
  }
  return dot / Math.sqrt(left * right)
}

function alignment(actual: Float64Array): number {
  const reference = source.slice(...firstBurst)
  let bestLag = 0, bestCorrelation = -Infinity
  for (let lag = 0; lag <= budgets.maxAlignmentSamples; lag++) {
    const score = correlation(reference, actual.subarray(firstBurst[0] + lag, firstBurst[1] + lag))
    if (score > bestCorrelation) { bestLag = lag; bestCorrelation = score }
  }
  return bestLag
}

function speech(values: Float64Array, lag = 0): Float64Array {
  return Float64Array.from(speechRanges.flatMap(([start, end]) => Array.from(values.subarray(start + lag, end + lag))))
}

let cleaned: Float64Array | undefined
function cleanOutput(): Float64Array {
  return cleaned ??= output(runFfmpeg({ mode: "clean" }))
}

nativeTest("native FFmpeg bypass preserves every finite PCM16 sample", () => {
  output(bypass)
  expect(bypass.stdout.equals(input)).toBe(true)
  expect(source.length).toBe(at(5.8))
  expect(peak(source)).toBeGreaterThan(0.98)
})

nativeTest("native FFmpeg cleanup retains speech and edge bursts within the locked budgets", () => {
  const actual = cleanOutput()
  const lag = alignment(actual)
  const metrics = {
    sampleCount: actual.length, alignmentSamples: lag, alignmentMs: lag / sampleRate * 1_000,
    noiseAttenuationDb: -energyDb(source.slice(at(0.4), at(0.9)), actual.slice(at(0.4) + lag, at(0.9) + lag)),
    speechEnergyDb: energyDb(speech(source), speech(actual, lag)),
    correlation: correlation(speech(source), speech(actual, lag)),
    peak: peak(actual),
    alignmentCorrelation: correlation(
      source.slice(...firstBurst), actual.slice(firstBurst[0] + lag, firstBurst[1] + lag),
    ),
    firstBurstEnergyDb: energyDb(source.slice(...firstBurst), actual.slice(firstBurst[0] + lag, firstBurst[1] + lag)),
    lastBurstEnergyDb: energyDb(source.slice(...lastBurst), actual.slice(lastBurst[0] + lag, lastBurst[1] + lag)),
  }
  console.info("Native FFmpeg DSP clean:", JSON.stringify(metrics))
  expect(metrics.sampleCount).toBe(source.length)
  expect(metrics.alignmentSamples).toBeLessThanOrEqual(budgets.maxAlignmentSamples)
  expect(metrics.alignmentCorrelation).toBeGreaterThanOrEqual(budgets.correlation)
  expect(metrics.noiseAttenuationDb).toBeGreaterThanOrEqual(budgets.noiseAttenuationDb)
  expect(Math.abs(metrics.speechEnergyDb)).toBeLessThanOrEqual(budgets.speechEnergyDb)
  expect(metrics.correlation).toBeGreaterThanOrEqual(budgets.correlation)
  expect(metrics.peak).toBeLessThanOrEqual(budgets.peak)
  expect(Math.abs(metrics.firstBurstEnergyDb)).toBeLessThanOrEqual(budgets.burstEnergyDb)
  expect(Math.abs(metrics.lastBurstEnergyDb)).toBeLessThanOrEqual(budgets.burstEnergyDb)
})

function projection(values: Float64Array, frequency: number, start: number, end: number): number {
  let sine = 0, cosine = 0
  for (let i = start; i < end; i++) {
    const phase = 2 * Math.PI * frequency * i / sampleRate
    sine += values[i] * Math.sin(phase)
    cosine += values[i] * Math.cos(phase)
  }
  return 2 * Math.hypot(sine, cosine) / (end - start)
}

for (const humHz of [50, 60] as const) {
  nativeTest(`native FFmpeg explicit ${humHz} Hz notch adds at least 6 dB hum attenuation`, () => {
    const clean = cleanOutput()
    const notched = output(runFfmpeg({ mode: "clean", humHz }))
    const lag = alignment(clean)
    const start = at(humHz === 50 ? 2.8 : 3.8) + lag
    const end = at(humHz === 50 ? 3.2 : 4.2) + lag
    const attenuationDb = 20 * Math.log10(
      projection(clean, humHz, start, end) / projection(notched, humHz, start, end),
    )
    console.info(`Native FFmpeg DSP ${humHz} Hz extra attenuation:`, attenuationDb)
    expect(notched.length).toBe(source.length)
    expect(attenuationDb).toBeGreaterThanOrEqual(budgets.humAttenuationDb)
  })
}
