import { expect, test } from "bun:test"
import { installDictation } from "./integration"
import type { Backend } from "./dictation"

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function fixture() {
  let text = "Existing text: "
  let submissions = 0
  const editor = {
    id: "renderable-12",
    focused: true,
    focusable: true,
    isDestroyed: false,
    traits: { owner: "opencode", role: "prompt" },
    hasSelection: () => false,
    insertText: (value: string) => { text += value },
  }
  const renderer = { currentFocusedEditor: editor, isDestroyed: false }
  let commands: { slash?: { name: string }; run: () => void }[] = []
  const context = {
    renderer,
    location: { id: "local" },
    data: { location: { default: () => ({ id: "local" }) } },
    keymap: { layer: (factory: () => { commands: typeof commands }) => { commands = factory().commands } },
    ui: {
      router: { current: () => ({ type: "session", sessionID: "one" }) },
      toast: { show: () => {} },
      dialog: { select: async () => undefined },
    },
    client: { session: { prompt: () => { submissions++ } } },
  } as unknown as Parameters<typeof installDictation>[0]
  const calls: string[] = []
  const backend: Backend = {
    async start() {
      calls.push("start")
      return { async stop() { return "audio.wav" }, async cancel() {} }
    },
    async transcribe() { return "prueba de dictado en español" },
  }
  return {
    context, backend, renderer, calls,
    text: () => text,
    submissions: () => submissions,
    command(name: string) {
      const command = commands.find((item) => item.slash?.name === name)
      if (!command) throw new Error(`Missing /${name} command`)
      command.run()
    },
  }
}

test("the registered terminal command starts and stops dictation without sending a prompt", async () => {
  const f = fixture()
  const cleanup = installDictation(f.context, f.backend)
  try {
    f.command("dictate")
    await tick()
    expect(f.calls).toEqual(["start"])
    f.command("dictate")
    await tick()
    expect(f.text()).toBe("Existing text: prueba de dictado en español")
    expect(f.submissions()).toBe(0)
  } finally { cleanup() }
})

test("a changed editor keeps the result pending until explicit insertion", async () => {
  const f = fixture()
  const cleanup = installDictation(f.context, f.backend)
  try {
    f.command("dictate")
    await tick()
    const original = f.renderer.currentFocusedEditor
    let otherText = ""
    f.renderer.currentFocusedEditor = { ...original, id: "renderable-99", insertText: (s) => { otherText += s } }
    f.command("dictate")
    await tick()
    expect(f.text()).toBe("Existing text: ")
    expect(otherText).toBe("")
    f.command("dictate-insert")
    await tick()
    expect(otherText).toBe("prueba de dictado en español")
    expect(f.submissions()).toBe(0)
  } finally { cleanup() }
})

test("plugin cleanup aborts inference and prevents late insertion", async () => {
  const f = fixture()
  let complete!: (text: string) => void
  f.backend.transcribe = () => new Promise((resolve) => { complete = resolve })
  const cleanup = installDictation(f.context, f.backend)
  f.command("dictate")
  await tick()
  f.command("dictate")
  await tick()
  cleanup()
  complete("Do not insert after reload")
  await tick()
  expect(f.text()).toBe("Existing text: ")
  expect(f.submissions()).toBe(0)
})
