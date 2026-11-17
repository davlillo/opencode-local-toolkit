import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultCaptureCommand, findNativeWorker, parseRecognitionMessage, resolveWorkerCommand, WindowsStreamingBackend } from "./streaming-backend"

test("the native worker requires both the executable and a loadable libvosk.dll", async () => {
  const dir = await mkdtemp(join(tmpdir(), "native-probe-"))
  try {
    const exe = join(dir, "dictation-core.exe")
    const dll = join(dir, "libvosk.dll")
    expect(await findNativeWorker(exe, "", [dll])).toBeUndefined()

    await writeFile(exe, "")
    expect(await findNativeWorker(exe, "", [dll])).toBeUndefined()

    await writeFile(dll, "")
    expect(await findNativeWorker(exe, "", [dll])).toBe(exe)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("invalid audio settings fail before any process starts", async () => {
  const previous = process.env.OPENCODE_ASR_AUDIO
  process.env.OPENCODE_ASR_AUDIO = "loud"
  try {
    await expect(backend().startStream(new AbortController().signal, () => {}))
      .rejects.toThrow(/OPENCODE_ASR_AUDIO/)
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_ASR_AUDIO
    else process.env.OPENCODE_ASR_AUDIO = previous
  }
})

test("prefers the built native core and falls back to the private Python runtime", async () => {
  delete process.env.OPENCODE_ASR_AUDIO
  const nativePath = join(import.meta.dir, "native", "build", "dictation-core.exe")
  const model = join(import.meta.dir)
  const resolved = await resolveWorkerCommand(model)
  if (await Bun.file(nativePath).exists()) {
    expect(resolved.executable).toBe(nativePath)
    expect(resolved.args).toEqual(["--model", model])
  } else {
    expect(resolved.args.at(-2)).toBe("--model")
    expect(resolved.executable).toMatch(/python\.exe$/)
  }
})

test("the real capture command applies the cleanup profile and can bypass it", () => {
  const previous = { audio: process.env.OPENCODE_ASR_AUDIO, hum: process.env.OPENCODE_ASR_HUM_HZ }
  try {
    delete process.env.OPENCODE_ASR_AUDIO
    delete process.env.OPENCODE_ASR_HUM_HZ
    const clean = defaultCaptureCommand("Mic (USB)", "ffmpeg-clean")
    expect(clean.executable).toBe("ffmpeg-clean")
    expect(clean.args).toContain("audio=Mic (USB)")
    expect(clean.args.join(" ")).toContain("highpass=f=70")
    expect(clean.args).toContain("-af")
    expect(clean.args.slice(7)).toEqual([
      "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-t", "65", "-f", "s16le", "pipe:1",
    ])

    process.env.OPENCODE_ASR_AUDIO = "off"
    const bypass = defaultCaptureCommand("Mic (USB)", "ffmpeg")
    expect(bypass.args).not.toContain("-af")
    expect(bypass.args.slice(-11)).toEqual([
      "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-t", "65", "-f", "s16le", "pipe:1",
    ])
  } finally {
    if (previous.audio === undefined) delete process.env.OPENCODE_ASR_AUDIO
    else process.env.OPENCODE_ASR_AUDIO = previous.audio
    if (previous.hum === undefined) delete process.env.OPENCODE_ASR_HUM_HZ
    else process.env.OPENCODE_ASR_HUM_HZ = previous.hum
  }
})

test("accepts only bounded, typed recognition messages", () => {
  expect(parseRecognitionMessage('{"type":"ready"}')).toEqual({ type: "ready" })
  expect(parseRecognitionMessage('{"type":"partial","text":"código español"}'))
    .toEqual({ type: "partial", text: "código español" })
  expect(() => parseRecognitionMessage('{"type":"final","text":42}')).toThrow()
  expect(() => parseRecognitionMessage('{"type":"execute","command":"anything"}')).toThrow()
  expect(() => parseRecognitionMessage("x".repeat(65_537))).toThrow()
})

function backend() {
  return new WindowsStreamingBackend({
    model: import.meta.dir,
    device: "synthetic test input",
    workerCommand: { executable: process.execPath, args: [join(import.meta.dir, "tests/fake-worker.ts")] },
    captureCommand: { executable: process.execPath, args: [join(import.meta.dir, "tests/fake-capture.ts")] },
  })
}

test("pipes binary input and publishes output while capture is still open", async () => {
  const drafts: string[] = []
  const abort = new AbortController()
  const recording = await backend().startStream(abort.signal, (text) => drafts.push(text))
  try {
    const deadline = Date.now() + 3_000
    while (!drafts.length && Date.now() < deadline) await Bun.sleep(10)
    expect(drafts.length).toBeGreaterThan(0)
    expect(abort.signal.aborted).toBe(false)
    const [first, second] = await Promise.all([recording.finish(), recording.finish()])
    expect(first).toMatch(/^bytes:[1-9]\d*$/)
    expect(second).toBe(first)
  } finally { await recording.cancel() }
}, 10_000)

test("abort releases both owned processes and refuses a final transcript", async () => {
  const abort = new AbortController()
  const recording = await backend().startStream(abort.signal, () => {})
  abort.abort()
  await expect(recording.finish()).rejects.toThrow()
  await recording.cancel()
})
