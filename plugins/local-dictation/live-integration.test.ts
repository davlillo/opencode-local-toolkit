import { expect, test } from "bun:test"
import { installDictation, previewVisible, type PreviewState } from "./integration"

const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function fixture() {
  let value = "Existing input: "
  let session = "one"
  let publish!: (text: string) => void
  let fail!: (error: Error) => void
  let commands: { slash?: { name: string }; run(): unknown }[] = []
  const views: PreviewState[] = []
  const errors: string[] = []
  const context = {
    location: { id: "local" },
    renderer: { isDestroyed: false, currentFocusedEditor: {
      id: "editor-one", focused: true, focusable: true, isDestroyed: false,
      traits: { owner: "opencode", role: "prompt" },
      hasSelection: () => false,
      insertText: (text: string) => { value += text },
    } },
    keymap: { layer: (factory: () => { commands: typeof commands }) => { commands = factory().commands } },
    ui: {
      router: { current: () => ({ type: "session", sessionID: session }) },
      toast: { show: (message: { variant?: string; message: string }) => {
        if (message.variant === "error") errors.push(message.message)
      } },
    },
  } as unknown as Parameters<typeof installDictation>[0]
  const dispose = installDictation(context, {
    async startStream(_signal, onDraft, onFailure) {
      publish = onDraft
      fail = onFailure!
      return { async finish() { return "hola mundo" }, async cancel() {} }
    },
  }, undefined, (view) => views.push(view))
  return {
    views, errors, dispose,
    value: () => value,
    publish: (text: string) => publish(text),
    fail: (error: Error) => fail(error),
    session: (value: string) => { session = value },
    async run(name: string) { commands.find((command) => command.slash?.name === name)!.run(); await turn() },
  }
}

test("live drafts replace the preview without touching existing prompt text", async () => {
  const f = fixture()
  try {
    await f.run("dictate")
    f.publish("hola")
    f.publish("hola mundo")
    expect(f.views.at(-1)?.draft).toBe("hola mundo")
    expect(f.value()).toBe("Existing input: ")
    const view = f.views.at(-1)!
    expect(previewVisible(view, "session:one", '{"id":"local"}')).toBe(true)
    f.session("two")
    expect(previewVisible(view, "session:two", '{"id":"local"}')).toBe(false)
    expect(previewVisible(view, "session:one", '{"id":"other"}')).toBe(false)
    f.session("one")
    await f.run("dictate-stop")
    expect(f.value()).toBe("Existing input: hola mundo")
    expect(f.views.at(-1)?.draft).toBe("")
  } finally { f.dispose() }
})

test("cancel clears the draft and ignores further hypotheses", async () => {
  const f = fixture()
  try {
    await f.run("dictate")
    f.publish("current")
    await f.run("dictate-cancel")
    f.publish("stale")
    expect(f.views.at(-1)?.draft).toBe("")
    expect(f.value()).toBe("Existing input: ")
  } finally { f.dispose() }
})

test("a fatal streaming error clears the draft and reports the failure", async () => {
  const f = fixture()
  try {
    await f.run("dictate")
    f.publish("unfinished")
    f.fail(new Error("Recognizer disconnected"))
    await turn()
    expect(f.views.at(-1)?.phase).toBe("idle")
    expect(f.views.at(-1)?.draft).toBe("")
    expect(f.errors).toEqual(["Recognizer disconnected"])
    expect(f.value()).toBe("Existing input: ")
  } finally { f.dispose() }
})
