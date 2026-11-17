import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { parseAudioDevices, type Backend, type Recording } from "./dictation"

const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
const root = join(local, "opencode-asr")

interface ProcessResult { code: number; stdout: string; stderr: string }
export type ProcessWait = <T>(promise: Promise<T>, milliseconds: number, message: string) => Promise<T>
export interface LaunchOptions {
  spawnProcess?: typeof spawn
  waitFor?: ProcessWait
}

export interface RunningProcess {
  child: ChildProcessWithoutNullStreams
  done: Promise<ProcessResult>
  closed(): boolean
  terminate?(): Promise<void>
}

export async function waitForProcess<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}

export function launch(
  executable: string,
  args: string[],
  signal: AbortSignal,
  timeout: number,
  allowedCodes = [0],
  onStderr?: (text: string) => void,
  binaryStdout = false,
  options: LaunchOptions = {},
): RunningProcess {
  signal.throwIfAborted()
  const child = (options.spawnProcess ?? spawn)(executable, args, { windowsHide: true, shell: false, stdio: "pipe" })
  let closed = false
  let settled = false
  let spawnFailed = false
  let killRequested = false
  let stdout = ""
  let stderr = ""
  let failure: Error | undefined
  const kill = () => {
    if (closed || spawnFailed || killRequested) return
    killRequested = true
    try { child.kill() } catch (error) {
      failure ??= error instanceof Error ? error : new Error(String(error))
    }
  }
  const abort = () => { failure ??= new Error("Dictation cancelled."); kill() }
  const timer = setTimeout(() => { failure ??= new Error("Local audio process timed out."); kill() }, timeout)
  const detach = () => {
    clearTimeout(timer)
    signal.removeEventListener("abort", abort)
  }
  signal.addEventListener("abort", abort, { once: true })
  if (!binaryStdout) child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  if (!binaryStdout) child.stdout.on("data", (chunk: string) => { stdout = (stdout + chunk).slice(-32_000) })
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-32_000)
    onStderr?.(stderr)
  })
  child.stdin.on("error", (error: NodeJS.ErrnoException) => {
    // FFmpeg can finish naturally just before the stop key reaches its input.
    if (error.code === "EPIPE") return
    failure ??= error
    kill()
  })
  let acknowledgeClose!: () => void
  const closing = new Promise<void>((resolve) => { acknowledgeClose = resolve })
  const done = new Promise<ProcessResult>((resolve, reject) => {
    const settle = (error?: Error, code = -1) => {
      if (settled) return
      settled = true
      detach()
      if (error || failure) reject(error ?? failure)
      else if (!allowedCodes.includes(code)) {
        reject(new Error(`Local audio process failed (${code}): ${stderr.slice(-1_200)}`))
      } else resolve({ code, stdout, stderr })
    }
    child.once("error", (error) => {
      // A failed spawn owns no OS child; an error from a spawned child is not close.
      spawnFailed = child.pid === undefined
      settle(error)
    })
    // Termination waits for process death; a 'close' event additionally requires
    // stdio flushes, which can lag arbitrarily when nobody drains a killed child's pipes.
    child.once("exit", () => { closed = true; acknowledgeClose() })
    child.once("close", (code) => {
      closed = true
      acknowledgeClose()
      settle(undefined, code ?? -1)
    })
  })
  let termination: Promise<void> | undefined
  const terminate = () => {
    termination ??= (async () => {
      detach()
      if (closed || spawnFailed) return
      failure ??= new Error("Dictation cancelled.")
      kill()
      await (options.waitFor ?? waitForProcess)(
        closing, 2_000, "Local audio process did not close after termination.",
      )
    })()
    return termination
  }
  if (signal.aborted) abort()
  // A recorder may exit before stop() awaits it; the original promise still rejects to its caller.
  void done.catch(() => {})
  return { child, done, closed: () => closed, terminate }
}

export interface WhisperOptions {
  whisper?: string
  model?: string
  ffmpeg?: string
  device?: string
  chooseDevice?: (devices: string[]) => Promise<string | undefined>
}

export class WindowsWhisperBackend implements Backend {
  private readonly whisper: string
  private readonly model: string
  private readonly ffmpeg: string
  private device?: string

  constructor(private readonly options: WhisperOptions = {}) {
    this.whisper = options.whisper ?? join(root, "bin", "whisper-cli.exe")
    this.model = options.model ?? join(root, "models", "ggml-base-q5_1.bin")
    this.ffmpeg = options.ffmpeg ?? process.env.OPENCODE_ASR_FFMPEG ?? "ffmpeg"
    this.device = options.device ?? process.env.OPENCODE_ASR_DEVICE
  }

  async devices(signal: AbortSignal): Promise<string[]> {
    const result = await launch(this.ffmpeg,
      ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
      signal, 10_000, [0, 1]).done
    return parseAudioDevices(result.stderr)
  }

  async start(signal: AbortSignal): Promise<Recording> {
    if (process.platform !== "win32") throw new Error("Local dictation currently supports Windows only.")
    try {
      await Promise.all([access(this.whisper), access(this.model)])
    } catch (cause) {
      throw new Error(`Local ASR is missing from ${root}. No microphone was opened.`, { cause })
    }
    if (!this.device) {
      const devices = await this.devices(signal)
      if (!devices.length) throw new Error("No DirectShow microphone found. Check Windows microphone settings.")
      this.device = devices.length === 1 ? devices[0] : await this.options.chooseDevice?.(devices)
      if (!this.device) throw new Error("No microphone selected. Recording did not start.")
    }
    signal.throwIfAborted()
    const tempRoot = join(local, "Temp", "opencode")
    await mkdir(tempRoot, { recursive: true })
    const directory = await mkdtemp(join(tempRoot, "dictation-"))
    const file = join(directory, "capture.wav")
    let ready!: () => void
    const started = new Promise<void>((resolve) => { ready = resolve })
    let running: RunningProcess | undefined
    let startupTimer: ReturnType<typeof setTimeout> | undefined
    try {
      running = launch(this.ffmpeg, [
        "-hide_banner", "-f", "dshow", "-i", `audio=${this.device}`,
        "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-t", "65", "-y", file,
      ], signal, 75_000, [0], (text) => { if (text.includes("Output #0,")) ready() })
      await Promise.race([
        started,
        running.done.then(() => { throw new Error("Microphone capture ended before it became ready.") }),
        new Promise<never>((_resolve, reject) => {
          startupTimer = setTimeout(() => reject(new Error("Microphone did not become ready within 10 seconds.")), 10_000)
        }),
      ])
      signal.throwIfAborted()
      const active = running
      let cleanup: Promise<void> | undefined
      return {
        async stop() {
          if (!active.closed()) active.child.stdin.end("q\n")
          await active.done
          return file
        },
        cancel() {
          cleanup ??= (async () => {
            if (!active.closed()) active.child.kill()
            // Cancellation discards process output; cleanup failures still propagate.
            await active.done.catch(() => {})
            await rm(directory, { recursive: true, force: true })
          })()
          return cleanup
        },
      }
    } catch (error) {
      running?.child.kill()
      // The startup error is reported below; this is the same failed process, not a second failure.
      await running?.done.catch(() => {})
      await rm(directory, { recursive: true, force: true })
      throw error
    } finally {
      clearTimeout(startupTimer)
    }
  }

  async transcribe(file: string, signal: AbortSignal): Promise<string> {
    const output = join(dirname(file), "transcript")
    await launch(this.whisper, [
      "-ng", "-t", "4", "-l", "es", "-m", this.model, "-f", file, "-nt", "-otxt", "-of", output,
    ], signal, 120_000).done
    signal.throwIfAborted()
    return readFile(`${output}.txt`, "utf8")
  }
}
