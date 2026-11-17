import { describe, expect, test } from "bun:test"
import {
  DictationController,
  insertTranscript,
  normalizeTranscript,
  parseAudioDevices,
  type Backend,
  type Recording,
} from "./dictation"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function fixture() {
  const calls: string[] = []
  const recording: Recording = {
    async stop() { calls.push("stop"); return "capture.wav" },
    async cancel() { calls.push("cleanup") },
  }
  const backend: Backend = {
    async start() { calls.push("start"); return recording },
    async transcribe(file) {
      calls.push(`transcribe:${file}`)
      return "  Revisa el código.\r\nAntes de enviarlo.  "
    },
  }
  return { backend, recording, calls }
}

describe("local terminal dictation", () => {
  test("records, stops, transcribes Spanish and releases the recording", async () => {
    const { backend, calls } = fixture()
    const controller = new DictationController(backend)
    await controller.start()
    expect(controller.phase).toBe("recording")
    expect(await controller.stop()).toBe("Revisa el código. Antes de enviarlo.")
    expect(controller.phase).toBe("idle")
    expect(calls).toEqual(["start", "stop", "transcribe:capture.wav", "cleanup"])
  })

  test("does not open two recordings or transcribe twice", async () => {
    const { backend, calls } = fixture()
    const controller = new DictationController(backend)
    await controller.start()
    await expect(controller.start()).rejects.toThrow("already active")
    await Promise.all([controller.stop(), controller.stop()])
    expect(calls.filter((call) => call === "start")).toHaveLength(1)
    expect(calls.filter((call) => call.startsWith("transcribe:"))).toHaveLength(1)
  })

  test("cancellation during startup disposes a late recording", async () => {
    const { backend, recording, calls } = fixture()
    const ready = deferred<Recording>()
    backend.start = () => ready.promise
    const controller = new DictationController(backend)
    const started = controller.start()
    await controller.cancel()
    ready.resolve(recording)
    await started
    expect(controller.phase).toBe("idle")
    expect(calls).toEqual(["cleanup"])
  })

  test("cancellation aborts inference and discards a late transcript", async () => {
    const { backend } = fixture()
    const result = deferred<string>()
    let signal: AbortSignal | undefined
    backend.transcribe = (_file, abort) => { signal = abort; return result.promise }
    const controller = new DictationController(backend)
    await controller.start()
    const stopped = controller.stop()
    await Promise.resolve()
    await controller.cancel()
    result.resolve("This cancelled result must not be inserted.")
    expect(await stopped).toBeUndefined()
    expect(signal?.aborted).toBe(true)
    expect(controller.phase).toBe("idle")
  })

  test("surfaces inference failure and still releases audio", async () => {
    const { backend, calls } = fixture()
    backend.transcribe = async () => { throw new Error("ASR failed") }
    const controller = new DictationController(backend)
    await controller.start()
    await expect(controller.stop()).rejects.toThrow("ASR failed")
    expect(controller.phase).toBe("idle")
    expect(calls.at(-1)).toBe("cleanup")
  })

  test("inserts a long transcript at the caret, preserving existing text without submitting", () => {
    let text = "Before:  :after"
    const transcript = "Dictado en español. ".repeat(20).trim()
    let submitted = false
    const editor = {
      id: "renderable-42",
      isDestroyed: false,
      focused: true,
      focusable: true,
      traits: { owner: "opencode", role: "prompt", status: undefined as string | undefined },
      hasSelection: () => false,
      insertText: (value: string) => { text = text.slice(0, 8) + value + text.slice(8) },
      submit: () => { submitted = true },
    }
    const target = { editor, id: editor.id, route: "session:one", location: "local" }
    expect(insertTranscript(target, target, transcript)).toBe(true)
    expect(text).toBe(`Before: ${transcript} :after`)
    expect(submitted).toBe(false)
  })

  test("keeps a result pending instead of replacing a selection or another session", () => {
    let inserted = false
    const editor = {
      id: "renderable-42",
      isDestroyed: false,
      focused: true,
      focusable: true,
      traits: { owner: "opencode", role: "prompt", status: undefined as string | undefined },
      hasSelection: () => true,
      insertText: () => { inserted = true },
    }
    const target = { editor, id: editor.id, route: "session:one", location: "local" }
    expect(insertTranscript(target, target, "Do not replace selection")).toBe(false)
    editor.hasSelection = () => false
    expect(insertTranscript(target, { ...target, route: "session:two" }, "Wrong session")).toBe(false)
    expect(insertTranscript(target, { ...target, editor: { ...editor } }, "Wrong editor")).toBe(false)
    expect(insertTranscript(target, { ...target, location: "other" }, "Wrong location")).toBe(false)
    editor.traits.status = "SHELL"
    expect(insertTranscript(target, target, "Shell mode")).toBe(false)
    editor.traits.status = undefined
    editor.focused = false
    expect(insertTranscript(target, target, "Unfocused editor")).toBe(false)
    editor.focused = true
    editor.isDestroyed = true
    expect(insertTranscript(target, target, "Destroyed editor")).toBe(false)
    expect(inserted).toBe(false)
  })

  test("normalizes whitespace and control sequences while preserving Spanish", () => {
    expect(normalizeTranscript("\u001b[31m  código\r\n  español\t\u0000 listo \u001b[0m"))
      .toBe("código español listo")
  })

  test("finds DirectShow audio devices without confusing video or alternative names", () => {
    const listing = [
      '[dshow @ 123] "Camera" (video)',
      '[dshow @ 123] "Micrófono (Realtek)" (audio)',
      '[dshow @ 123]   Alternative name "@device_cm_{123}"',
      '[dshow @ 123] "Headset" (audio)',
    ].join("\n")
    expect(parseAudioDevices(listing)).toEqual(["Micrófono (Realtek)", "Headset"])
  })
})
