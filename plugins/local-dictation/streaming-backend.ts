import type { StreamingBackend, StreamingRecording } from "./dictation"
import { access } from "node:fs/promises"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { launch, waitForProcess, WindowsWhisperBackend, type ProcessWait, type RunningProcess } from "./backend"
import { audioFilterArgs, resolveAudioPipeline, type AudioPipelineSettings } from "./audio-pipeline"

export type RecognitionMessage =
  | { type: "ready" }
  | { type: "partial" | "final"; text: string }
  | { type: "error"; message: string }

interface Command { executable: string; args: string[] }

// Capture profile shared by the real DirectShow path; audio cleanup is opt-out via env.
export function defaultCaptureCommand(
  device: string | undefined,
  ffmpeg?: string,
  audio: AudioPipelineSettings = resolveAudioPipeline(),
): Command {
  return {
    executable: ffmpeg ?? process.env.OPENCODE_ASR_FFMPEG ?? "ffmpeg",
    args: [
      "-hide_banner", "-f", "dshow", "-i", `audio=${device}`,
      ...audioFilterArgs(audio),
      "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-t", "65", "-f", "s16le", "pipe:1",
    ],
  }
}

export interface StreamingOptions {
  python?: string
  model?: string
  worker?: string
  ffmpeg?: string
  device?: string
  chooseDevice?: (devices: string[]) => Promise<string | undefined>
  workerCommand?: Command
  captureCommand?: Command
  launchProcess?: typeof launch
  waitFor?: ProcessWait
}

// The native core is only usable when both the executable and a loadable
// libvosk.dll are reachable; otherwise recognition would fail after capture starts.
export async function findNativeWorker(
  executable = join(import.meta.dir, "native", "build", "dictation-core.exe"),
  dll = process.env.DICTATION_CORE_VOSK_DLL,
  search?: string[],
): Promise<string | undefined> {
  const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
  const candidates = search ?? [
    join(dirname(executable), "libvosk.dll"),
    dll?.trim() || undefined,
    join(local, "opencode-asr", "venv-vosk", "Lib", "site-packages", "vosk", "libvosk.dll"),
  ].filter((value): value is string => !!value)
  try {
    await access(executable)
  } catch {
    return undefined
  }
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return executable
    } catch {
      // Try the next documented location.
    }
  }
  return undefined
}

// Worker preference: built native core when usable, private Python venv otherwise.
export async function resolveWorkerCommand(
  model: string,
  options: Pick<StreamingOptions, "python" | "worker"> = {},
): Promise<Command> {
  const native = await findNativeWorker()
  if (native) return { executable: native, args: ["--model", model] }
  const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
  return {
    executable: options.python ?? join(local, "opencode-asr", "venv-vosk", "Scripts", "python.exe"),
    args: ["-B", "-u", options.worker ?? join(import.meta.dir, "vosk-worker.py"), "--model", model],
  }
}

export function parseRecognitionMessage(line: string): RecognitionMessage {
  if (line.length > 65_536) throw new Error("Recognition message exceeds its size limit.")
  const value: unknown = JSON.parse(line)
  if (!value || typeof value !== "object") throw new Error("Invalid recognition message.")
  const message = value as Record<string, unknown>
  if (message.type === "ready") return { type: "ready" }
  if ((message.type === "partial" || message.type === "final")
    && typeof message.text === "string" && message.text.length <= 20_000) {
    return { type: message.type, text: message.text }
  }
  if (message.type === "error" && typeof message.message === "string" && message.message.length <= 4_000) {
    return { type: "error", message: message.message }
  }
  throw new Error("Invalid recognition message.")
}

function gate() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  void promise.catch(() => {})
  return { promise, resolve, reject }
}

export class WindowsStreamingBackend implements StreamingBackend {
  private device?: string
  constructor(private readonly options: StreamingOptions = {}) {}

  async startStream(
    signal: AbortSignal,
    onDraft: (text: string) => void,
    onFailure: (error: Error) => void = () => {},
  ): Promise<StreamingRecording> {
    const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
    const root = join(local, "opencode-asr")
    const model = this.options.model ?? join(root, "models", "vosk-model-small-es-0.42")
    // Validate typed audio settings before any device discovery can prompt the user.
    const audio = resolveAudioPipeline()
    const workerCommand = this.options.workerCommand ?? await resolveWorkerCommand(model, this.options)
    try {
      await Promise.all([access(workerCommand.executable), access(model)])
    } catch (cause) {
      throw new Error("The private Vosk runtime/model is missing. No microphone was opened.", { cause })
    }
    signal.throwIfAborted()
    this.device ??= this.options.device ?? process.env.OPENCODE_ASR_DEVICE
    if (!this.device && !this.options.captureCommand) {
      const devices = await new WindowsWhisperBackend({ ffmpeg: this.options.ffmpeg }).devices(signal)
      if (!devices.length) throw new Error("No DirectShow microphone found. Check Windows microphone settings.")
      this.device = devices.length === 1 ? devices[0] : await this.options.chooseDevice?.(devices)
      if (!this.device) throw new Error("No microphone selected. Recording did not start.")
    }
    const captureCommand = this.options.captureCommand ?? defaultCaptureCommand(this.device, this.options.ffmpeg, audio)
    signal.throwIfAborted()
    const launchProcess = this.options.launchProcess ?? launch
    const waitFor = this.options.waitFor ?? waitForProcess
    const group = new AbortController()
    const ready = gate()
    const capturing = gate()
    let worker: RunningProcess | undefined
    let capture: RunningProcess | undefined
    let failure: Error | undefined
    let handedOff = false
    let finishing = false
    let shuttingDown = false
    let readySeen = false
    let finalText: string | undefined
    let buffer = ""
    const abort = () => {
      shuttingDown = true
      group.abort()
      ready.reject(signal.reason)
      capturing.reject(signal.reason)
    }
    signal.addEventListener("abort", abort, { once: true })
    const fail = (error: unknown) => {
      if (shuttingDown || failure || signal.aborted) return
      failure = error instanceof Error ? error : new Error(String(error))
      shuttingDown = true
      group.abort()
      ready.reject(failure)
      capturing.reject(failure)
      if (handedOff) onFailure(failure)
    }
    let cleanup: Promise<void> | undefined
    const release = () => {
      // Mark the terminal state before abort can reject either child's done promise.
      shuttingDown = true
      cleanup ??= (async () => {
        signal.removeEventListener("abort", abort)
        if (capture && worker) capture.child.stdout.unpipe(worker.child.stdin)
        group.abort()
        // A killed child's stdout piped into a dead worker has no drain; Bun defers
        // its close event until the stream finalizes, so end it explicitly.
        capture?.child.stdout.destroy()
        const owned = [
          { running: worker, label: "Recognizer" },
          { running: capture, label: "Audio capture" },
        ]
        const outcomes = await Promise.allSettled(owned.map(async ({ running }) => {
          if (!running) return
          if (running.terminate) return running.terminate()
          // Compatibility for injected handles implementing the original optional surface.
          if (running.closed()) return
          let acknowledge!: () => void
          const closing = new Promise<void>((resolve) => { acknowledge = resolve })
          running.child.once("close", acknowledge)
          try {
            if (!running.child.killed) running.child.kill()
            await waitFor(closing, 2_000, "Local audio process did not close after termination.")
          } finally { running.child.removeListener("close", acknowledge) }
        }))
        const errors = outcomes.flatMap((outcome, index) => {
          if (outcome.status === "fulfilled") return []
          const reason = outcome.reason
          const message = reason instanceof Error ? reason.message : String(reason)
          return [new Error(`${owned[index]!.label} did not close: ${message}`, { cause: reason })]
        })
        if (errors.length) {
          // The UI reports the primary finish error; close failures must remain visible as well.
          console.error("Local dictation cleanup failed:", errors.map((error) => error.message).join(" "))
          throw new AggregateError(errors, "Local dictation cleanup failed.")
        }
      })()
      return cleanup
    }
    const annotateCleanup = (primary: unknown, error: unknown) => {
      if (primary instanceof Error && Object.isExtensible(primary)
        && Object.getOwnPropertyDescriptor(primary, "cleanupError")?.configurable !== false) {
        Object.defineProperty(primary, "cleanupError", { value: error, configurable: true })
      }
    }
    let finishFailed = false
    let finishError: unknown
    let cancelling: Promise<void> | undefined
    let cancelRequested = false
    const cancel = () => {
      cancelRequested = true
      cancelling ??= release().catch((error) => {
        if (finishFailed) {
          if (error !== finishError) annotateCleanup(finishError, error)
          throw finishError
        }
        throw error
      })
      return cancelling
    }
    try {
      if (signal.aborted) abort()
      worker = launchProcess(workerCommand.executable, workerCommand.args, group.signal, 95_000)
      worker.child.stdout.on("data", (chunk: string) => {
        if (shuttingDown || signal.aborted || failure) return
        try {
          buffer += chunk
          let newline: number
          while (!shuttingDown && (newline = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newline).trim()
            buffer = buffer.slice(newline + 1)
            if (!line) continue
            const message = parseRecognitionMessage(line)
            if (message.type === "error") throw new Error(message.message)
            if (message.type === "ready") {
              if (readySeen) throw new Error("Recognizer sent duplicate readiness.")
              readySeen = true
              ready.resolve()
            } else {
              if (!readySeen || finalText !== undefined) throw new Error("Invalid recognition message order.")
              if (message.type === "partial") onDraft(message.text)
              else finalText = message.text
            }
          }
          if (buffer.length > 65_536) throw new Error("Recognition message exceeds its size limit.")
        } catch (error) { fail(error) }
      })
      void worker.done.then(() => {
        if (!finishing) fail(new Error("Recognizer ended before recording was stopped."))
        else if (buffer.trim() || finalText === undefined) fail(new Error("Recognizer ended without a complete result."))
      }, fail)
      await waitFor(ready.promise, 20_000, "Local recognizer did not become ready.")
      signal.throwIfAborted()
      capture = launchProcess(captureCommand.executable, captureCommand.args, group.signal, 75_000, [0],
        (text) => { if (text.includes("Output #0,")) capturing.resolve() }, true)
      // Raw PCM is never decoded as UTF-8, buffered as a transcript, or written to disk.
      capture.child.stdout.pipe(worker.child.stdin)
      void capture.done.then(() => {
        if (!finishing) fail(new Error("Audio capture ended before recording was stopped."))
      }, fail)
      await waitFor(capturing.promise, 10_000, "Audio input did not become ready.")
      signal.throwIfAborted()
      if (failure) throw failure
      handedOff = true
      const audio = capture
      const recognizer = worker
      let finalizing: Promise<string> | undefined
      return {
        finish: () => {
          finalizing ??= (async () => {
            let result: string | undefined
            try {
              if (failure) throw failure
              signal.throwIfAborted()
              if (shuttingDown) throw new Error("Dictation cancelled.")
              finishing = true
              if (!audio.closed()) audio.child.stdin.end("q\n")
              await waitFor(audio.done, 10_000, "Audio capture did not stop.")
              await waitFor(recognizer.done, 10_000, "Local recognizer did not flush its final result.")
              if (failure) throw failure
              signal.throwIfAborted()
              if (finalText === undefined) throw new Error("No finalized recognition result was received.")
              result = finalText
            } catch (error) {
              finishFailed = true
              finishError = failure ?? (signal.aborted ? signal.reason : error)
            }
            try { await release() } catch (error) {
              if (finishFailed) annotateCleanup(finishError, error)
              else { finishFailed = true; finishError = error }
            }
            if (finishFailed) throw finishError
            signal.throwIfAborted()
            if (cancelRequested) throw new Error("Dictation cancelled.")
            return result!
          })()
          return finalizing
        },
        cancel,
      }
    } catch (error) {
      const primary = failure ?? error
      try { await release() } catch (cleanupError) { annotateCleanup(primary, cleanupError) }
      throw primary
    }
  }
}
