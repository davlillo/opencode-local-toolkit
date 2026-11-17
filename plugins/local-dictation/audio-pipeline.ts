export interface AudioPipelineSettings {
  mode: "clean" | "off"
  humHz?: 50 | 60
}

/** Resolve only the two allowlisted controls; invalid values fail before capture. */
export function resolveAudioPipeline(environment: {
  OPENCODE_ASR_AUDIO?: string
  OPENCODE_ASR_HUM_HZ?: string
} = {
  OPENCODE_ASR_AUDIO: process.env.OPENCODE_ASR_AUDIO,
  OPENCODE_ASR_HUM_HZ: process.env.OPENCODE_ASR_HUM_HZ,
}): AudioPipelineSettings {
  const mode = environment.OPENCODE_ASR_AUDIO === undefined ? "clean" : environment.OPENCODE_ASR_AUDIO
  const hum = environment.OPENCODE_ASR_HUM_HZ === undefined ? "off" : environment.OPENCODE_ASR_HUM_HZ
  if (mode !== "clean" && mode !== "off") {
    throw new Error("OPENCODE_ASR_AUDIO must be clean or off.")
  }
  if (hum !== "off" && hum !== "50" && hum !== "60") {
    throw new Error("OPENCODE_ASR_HUM_HZ must be off, 50, or 60.")
  }
  return hum === "off" ? { mode } : { mode, humHz: hum === "50" ? 50 : 60 }
}

/** Build output-side FFmpeg arguments without starting a process or accepting filter text. */
export function audioFilterArgs(settings: AudioPipelineSettings): string[] {
  if (settings.mode !== "clean" && settings.mode !== "off") {
    throw new Error("Audio pipeline mode must be clean or off.")
  }
  if (settings.humHz !== undefined && settings.humHz !== 50 && settings.humHz !== 60) {
    throw new Error("Audio pipeline humHz must be 50 or 60 when set.")
  }
  if (settings.mode === "off") return []
  const filters = [
    "aformat=sample_fmts=fltp:sample_rates=16000:channel_layouts=mono",
    "highpass=f=70:p=2",
    ...(settings.humHz === undefined ? [] : [`bandreject=f=${settings.humHz}:t=h:w=2`]),
    "afftdn=nr=6:nf=-50:tn=0",
    // Disable automatic level gain; latency compensation drains the 5 ms lookahead at EOF.
    "alimiter=limit=0.95:level=0:attack=5:release=50:latency=1",
  ]
  return ["-af", filters.join(",")]
}
