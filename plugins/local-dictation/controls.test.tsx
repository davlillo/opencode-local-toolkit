import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { testRender } from "@opentui/solid"
import type { TextareaRenderable } from "@opentui/core"
import { DictationControls, DictationPreview } from "./controls"
import { installDictation, previewVisible, viewIdentity, type PreviewState } from "./integration"

const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

async function fixture() {
  const [view, setView] = createSignal<PreviewState>({ phase: "idle", draft: "", pending: false })
  const [session, setSession] = createSignal("one")
  const [location, setLocation] = createSignal("local")
  let input!: TextareaRenderable
  let commands: { id?: string; run(): unknown }[] = []
  let publish!: (text: string) => void
  let starts = 0
  const dispatch = (id: string) => {
    const command = commands.find((entry) => entry.id === id)
    if (!command) throw new Error(`Missing ${id}`)
    command.run()
  }
  const identity = () => ({ route: `session:${session()}`, location: JSON.stringify({ id: location() }) })
  const sameTarget = () => view().route === identity().route && view().location === identity().location
  const setup = await testRender(() => <box flexDirection="column" width="100%">
    <textarea ref={(node) => { input = node }} height={3} width="100%" />
    <DictationControls phase={view().phase} pending={view().pending} sameTarget={sameTarget()}
      onToggle={() => dispatch("local.dictation.toggle")}
      onCancel={() => dispatch("local.dictation.cancel")}
      onInsert={() => dispatch("local.dictation.insert")} />
    <DictationPreview text={view().draft} pending={view().pending}
      visible={previewVisible(view(), identity().route, identity().location)} />
  </box>, { width: 80, height: 16 })
  const context = {
    renderer: setup.renderer,
    get location() { return { id: location() } },
    keymap: { layer: (factory: () => { commands: typeof commands }) => { commands = factory().commands }, dispatch },
    ui: {
      router: { current: () => ({ type: "session", sessionID: session() }) },
      toast: { show: () => {} },
    },
  } as unknown as Parameters<typeof installDictation>[0]
  const dispose = installDictation(context, {
    async startStream(_signal, onDraft) {
      starts++
      publish = onDraft
      return { async finish() { return "hola mundo" }, async cancel() {} }
    },
  }, undefined, (state) => setView(state))
  const promptTraits = { suspend: false, owner: "opencode", role: "prompt" }
  input.traits = promptTraits
  input.focus()
  input.insertText("Existing input: ")
  await setup.renderOnce()
  expect(input.traits).toMatchObject(promptTraits)
  function find(label: string) {
    const rows = setup.captureCharFrame().split("\n")
    const y = rows.findIndex((row) => row.includes(label))
    if (y < 0) throw new Error(`Missing visible control: ${label}`)
    return { x: rows[y]!.indexOf(label) + 1, y }
  }
  async function click(label: string) {
    await setup.renderOnce()
    const { x, y } = find(label)
    await setup.mockMouse.click(x, y)
    await turn()
    await setup.renderOnce()
  }
  return {
    ...setup, input, view, setSession, setLocation, click, find, starts: () => starts,
    publish: (text: string) => publish(text),
    async close() { dispose(); await setup.dispose() },
    context,
  }
}

test("the actual button preserves focus and selected prompt text", async () => {
  const f = await fixture()
  try {
    f.input.setSelection(0, 4)
    await f.click("Record")
    expect(f.renderer.currentFocusedEditor).toBe(f.input)
    expect(f.input.getSelectedText()).toBe("Exis")
    expect(f.input.plainText).toBe("Existing input: ")
    expect(f.starts()).toBe(0)
  } finally { await f.close() }
})

test("click start, live replacement and click stop use the real controls without auto-submitting", async () => {
  const f = await fixture()
  try {
    await f.click("Record")
    expect(f.starts()).toBe(1)
    expect(f.renderer.currentFocusedEditor).toBe(f.input)
    f.publish("hola")
    await f.renderOnce()
    expect(f.captureCharFrame()).toContain("hola")
    f.publish("hola mundo")
    await f.renderOnce()
    expect(f.captureCharFrame()).toContain("hola mundo")
    expect(f.captureCharFrame()).not.toContain("holahola")
    expect(f.input.plainText).toBe("Existing input: ")
    f.resize(44, 16)
    await f.renderOnce()
    expect(f.captureCharFrame()).toContain("Stop")
    await f.click("Stop")
    expect(f.input.plainText).toBe("Existing input: hola mundo")
    expect(f.view().phase).toBe("idle")
  } finally { await f.close() }
})

test("navigation hides the live draft immediately and explicit pending insertion stays scoped", async () => {
  const f = await fixture()
  try {
    await f.click("Record")
    f.publish("private draft")
    await f.renderOnce()
    expect(f.captureCharFrame()).toContain("private draft")
    f.setSession("two")
    await f.renderOnce()
    expect(f.captureCharFrame()).not.toContain("private draft")
    f.setSession("one")
    f.setLocation("other")
    await f.renderOnce()
    expect(f.captureCharFrame()).not.toContain("private draft")
    await f.click("Stop")
    expect(f.input.plainText).toBe("Existing input: ")
    f.setLocation("local")
    await f.renderOnce()
    expect(viewIdentity(f.context)).toMatchObject({ route: "session:one", location: '{"id":"local"}' })
    await f.click("Insert")
    expect(f.input.plainText).toBe("Existing input: hola mundo")
  } finally { await f.close() }
})

test("dragging out or releasing without a button press does not start recording", async () => {
  const f = await fixture()
  try {
    const { x, y } = f.find("Record")
    await f.mockMouse.release(x, y)
    await f.mockMouse.pressDown(x, y)
    await f.mockMouse.moveTo(70, 14)
    await f.mockMouse.release(70, 14)
    await turn()
    expect(f.starts()).toBe(0)
  } finally { await f.close() }
})
