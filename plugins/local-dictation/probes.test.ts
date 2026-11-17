import { expect, test } from "bun:test"
import { installDictation } from "./integration"
import type { Backend, PromptEditor, Recording } from "./dictation"

const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
function gate<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function capture(file: string) {
  return {
    stopCalls: 0, cancelCalls: 0,
    async stop() { this.stopCalls++; return file },
    async cancel() { this.cancelCalls++ },
  }
}
function editor(id: string) {
  return {
    id, value: "left:right", caret: 5, selected: false,
    focused: true, focusable: true, isDestroyed: false,
    traits: { owner: "opencode", role: "prompt", status: undefined as string | undefined },
    hasSelection() { return this.selected },
    insertText(text: string) {
      this.value = this.value.slice(0, this.caret) + text + this.value.slice(this.caret)
      this.caret += text.length
    },
  }
}
function fixture() {
  const original = editor("original")
  const renderer = { currentFocusedEditor: original as PromptEditor | null, isDestroyed: false }
  const messages: { message: string; variant?: string }[] = []
  const starts: AbortSignal[] = []
  const transcriptions: string[] = []
  const active = capture("active.wav")
  let session = "one"
  let location = "local"
  let submissions = 0
  let commands: { slash?: { name: string }; run(): unknown }[] = []
  const backend: Backend = {
    async start(signal) { starts.push(signal); return active },
    async transcribe(file) { transcriptions.push(file); return "fresh dictation" },
  }
  const context = {
    renderer,
    get location() { return { id: location } },
    data: { location: { default: () => ({ id: location }) } },
    keymap: { layer: (factory: () => { commands: typeof commands }) => { commands = factory().commands } },
    ui: {
      router: { current: () => ({ type: "session", sessionID: session }) },
      toast: { show: (value: { message: string; variant?: string }) => messages.push(value) },
      dialog: { select: async () => undefined },
    },
    client: { session: { prompt: () => { submissions++ } } },
  } as unknown as Parameters<typeof installDictation>[0]
  const dispose = installDictation(context, backend)
  const queue = (name: string) => {
    const command = commands.find((item) => item.slash?.name === name)
    if (!command) throw new Error(`Missing /${name}`)
    command.run()
  }
  return {
    original, renderer, messages, starts, transcriptions, active, backend, dispose, queue,
    setSession(value: string) { session = value },
    setLocation(value: string) { location = value },
    submissions: () => submissions,
    async run(name: string) { queue(name); await turn() },
  }
}
const focusError = "Focus the normal prompt and clear any text selection first."

test("guarded commands reject unsafe prompt states without starting a recorder", async () => {
  const f = fixture()
  try {
    expect(f.starts).toHaveLength(0)
    for (const state of ["selection", "shell", "unfocused", "destroyed", "foreign", "renderer"]) {
      f.original.selected = state === "selection"
      f.original.traits.status = state === "shell" ? "SHELL" : undefined
      f.original.focused = state !== "unfocused"
      f.original.isDestroyed = state === "destroyed"
      f.original.traits.owner = state === "foreign" ? "other" : "opencode"
      f.renderer.isDestroyed = state === "renderer"
      await f.run("dictate")
      expect(f.messages.at(-1)).toMatchObject({ message: focusError, variant: "error" })
      expect(f.original.value).toBe("left:right")
      expect(f.starts).toHaveLength(0)
    }
    expect(f.submissions()).toBe(0)
  } finally { f.dispose() }
})

test("cancelled startup cannot retarget or overwrite a newer recording", async () => {
  const f = fixture()
  const ready = gate<Recording>()
  const stale = capture("stale.wav")
  let aborted: AbortSignal | undefined
  f.backend.start = (signal) => { aborted = signal; return ready.promise }
  try {
    await f.run("dictate")
    await f.run("dictate-cancel")
    expect(aborted?.aborted).toBe(true)
    f.backend.start = async () => f.active
    await f.run("dictate")
    ready.resolve(stale)
    await turn()
    expect(stale.cancelCalls).toBe(1)
    expect(stale.stopCalls).toBe(0)
    f.original.value = "edited:right"
    f.original.caret = 7
    await f.run("dictate-stop")
    expect(f.transcriptions).toEqual(["active.wav"])
    expect(f.original.value).toBe("edited:fresh dictationright")
    expect(f.submissions()).toBe(0)
  } finally { f.dispose() }
})

test("cancel during audio finalization suppresses its late error and permits a fresh recording", async () => {
  const f = fixture()
  const drained = gate<string>()
  f.active.stop = () => drained.promise
  try {
    await f.run("dictate")
    await f.run("dictate-stop")
    await f.run("dictate-cancel")
    f.backend.start = async () => capture("new.wav")
    await f.run("dictate")
    drained.reject(new Error("Old capture closed after cancellation"))
    await turn()
    expect(f.messages.filter((item) => item.variant === "error")).toEqual([])
    expect(f.original.value).toBe("left:right")
    await f.run("dictate-stop")
    expect(f.transcriptions).toEqual(["new.wav"])
    expect(f.original.value).toBe("left:fresh dictationright")
    expect(f.submissions()).toBe(0)
  } finally { f.dispose() }
})

test("cancel while successful inference is awaiting cleanup still discards the computed result", async () => {
  const f = fixture()
  const cleaned = gate<void>()
  f.active.cancel = () => cleaned.promise
  try {
    await f.run("dictate")
    await f.run("dictate-stop")
    expect(f.transcriptions).toEqual(["active.wav"])
    expect(f.original.value).toBe("left:right")
    await f.run("dictate-cancel")
    cleaned.resolve()
    await turn()
    expect(f.original.value).toBe("left:right")
    await f.run("dictate-insert")
    expect(f.messages.at(-1)?.message).toBe("There is no pending transcript.")
    expect(f.submissions()).toBe(0)
  } finally { cleaned.resolve(); f.dispose() }
})

test("pending insertion requires the original session and location, plus a safe live prompt", async () => {
  const f = fixture()
  const replacement = editor("replacement")
  try {
    await f.run("dictate")
    f.setSession("two")
    f.setLocation("worktree")
    f.renderer.currentFocusedEditor = replacement
    await f.run("dictate-stop")
    for (const session of ["two", "one"]) {
      f.setSession(session)
      await f.run("dictate-insert")
      expect(f.messages.at(-1)).toMatchObject({
        message: "Return to the session where this dictation started.", variant: "error",
      })
      expect(replacement.value).toBe("left:right")
    }
    f.setLocation("local")
    replacement.traits.status = "SHELL"
    await f.run("dictate-insert")
    expect(f.messages.at(-1)?.message).toBe(focusError)
    replacement.traits.status = undefined
    replacement.selected = true
    await f.run("dictate-insert")
    expect(f.messages.at(-1)?.message).toBe(focusError)
    expect(replacement.value).toBe("left:right")
    replacement.selected = false
    await f.run("dictate-insert")
    expect(replacement.value).toBe("left:fresh dictationright")
    expect(f.original.value).toBe("left:right")
    expect(f.submissions()).toBe(0)
  } finally { f.dispose() }
})

test("cancelling a pending transcript removes it without touching either prompt", async () => {
  const f = fixture()
  const other = editor("other")
  try {
    await f.run("dictate")
    f.renderer.currentFocusedEditor = other
    await f.run("dictate-stop")
    await f.run("dictate-cancel")
    await f.run("dictate-insert")
    expect(f.messages.at(-1)?.message).toBe("There is no pending transcript.")
    expect(f.original.value).toBe("left:right")
    expect(other.value).toBe("left:right")
    expect(f.submissions()).toBe(0)
  } finally { f.dispose() }
})

for (const phase of ["starting", "finalizing", "inference"] as const) {
  test(`disposal during ${phase} aborts work and blocks queued and late insertions`, async () => {
    const f = fixture()
    const ready = gate<Recording>()
    const drained = gate<string>()
    const result = gate<string>()
    let signal: AbortSignal | undefined
    f.backend.start = async (abort) => {
      signal = abort
      return phase === "starting" ? ready.promise : f.active
    }
    if (phase === "finalizing") f.active.stop = () => drained.promise
    f.backend.transcribe = () => result.promise
    await f.run("dictate")
    if (phase !== "starting") await f.run("dictate-stop")
    const count = f.messages.length
    f.queue("dictate")
    f.dispose()
    ready.resolve(f.active)
    drained.resolve("active.wav")
    result.resolve("must never appear")
    await turn()
    expect(signal?.aborted).toBe(true)
    expect(f.active.cancelCalls).toBeGreaterThan(0)
    expect(f.original.value).toBe("left:right")
    expect(f.messages).toHaveLength(count)
    expect(f.submissions()).toBe(0)
  })
}
