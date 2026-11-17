import type { Context } from "@opencode/plugin/tui/context"
import { WindowsStreamingBackend } from "./streaming-backend"
import {
  canInsert, DictationController, insertTranscript, isPromptEditor,
  type Backend, type Phase, type PromptTarget, type StreamingBackend,
} from "./dictation"

export interface PreviewState {
  phase: Phase
  draft: string
  pending: boolean
  route?: string
  location?: string
}

export function previewVisible(view: PreviewState, route: string, location: string): boolean {
  return !!view.draft && view.route === route && view.location === location
}

export function viewIdentity(context: Pick<Context, "ui" | "location" | "data">) {
  const route = context.ui.router.current()
  return {
    route: route.type === "session" ? `session:${route.sessionID}` : route.type,
    location: JSON.stringify(context.location ?? context.data.location.default()),
  }
}

export function installDictation(
  context: Context,
  backend?: Backend | StreamingBackend,
  onPhase: (phase: Phase) => void = () => {},
  onPreview: (view: PreviewState) => void = () => {},
): () => void {
  let disposed = false
  let generation = 0
  let target: PromptTarget | undefined
  let pending: { target: PromptTarget; text: string } | undefined
  let draft = ""
  let limit: ReturnType<typeof setTimeout> | undefined
  const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info") => {
    if (!disposed) context.ui.toast.show({ title: "Local dictation", message, variant, duration: 8_000 })
  }
  const report = (error: unknown) => toast(error instanceof Error ? error.message : String(error), "error")
  const current = (): PromptTarget => {
    const focused = context.renderer.isDestroyed ? null : context.renderer.currentFocusedEditor
    const editor = isPromptEditor(focused) ? focused : null
    return {
      editor,
      id: editor?.id,
      ...viewIdentity(context),
    }
  }
  const controller = new DictationController(backend ?? new WindowsStreamingBackend({
    chooseDevice: (devices) => context.ui.dialog.select({
      title: "Choose a microphone for local dictation",
      options: devices.map((device) => ({ title: device, value: device })),
    }),
  }), (phase) => {
    clearTimeout(limit)
    if (disposed) return
    if (phase === "idle") draft = ""
    onPhase(phase)
    publish()
    if (phase === "recording") {
      toast("Recording locally. Click Stop when finished. Automatic stop after 60 seconds.", "warning")
      limit = setTimeout(() => { void finish().catch(report) }, 60_000)
    } else if (phase === "transcribing") toast("Finishing local dictation…")
  }, (text) => { draft = text; publish() }, report)

  function publish(): void {
    if (disposed) return
    const origin = pending?.target ?? target
    onPreview({
      phase: controller.phase, draft: pending?.text ?? draft, pending: !!pending,
      route: origin?.route, location: origin?.location,
    })
  }

  async function finish(): Promise<void> {
    const original = target
    const version = generation
    const text = await controller.stop()
    if (disposed || version !== generation || text === undefined || !original) return
    if (!text) {
      target = undefined
      publish()
      toast("No speech was recognized.", "warning")
      return
    }
    if (insertTranscript(original, current(), text)) {
      target = undefined
      toast("Dictation inserted. Review the text before sending.", "success")
    } else {
      pending = { target: original, text }
      toast("Transcript kept in memory. Return to the original session and use /dictate-insert.", "warning")
    }
    publish()
  }

  async function toggle(): Promise<void> {
    if (controller.phase === "recording") { await finish(); return }
    if (controller.phase !== "idle") { toast("Dictation is busy. Use /dictate-cancel to cancel.", "warning"); return }
    if (pending) { toast("Use /dictate-insert or /dictate-cancel before starting another recording.", "warning"); return }
    const prompt = current()
    if (!canInsert(prompt, prompt)) throw new Error("Focus the normal prompt and clear any text selection first.")
    target = prompt
    draft = ""
    generation++
    await controller.start()
  }

  async function cancel(): Promise<void> {
    generation++
    pending = undefined
    target = undefined
    draft = ""
    await controller.cancel()
    toast("Dictation cancelled. Recorded audio and pending text discarded.")
  }

  async function insertPending(): Promise<void> {
    if (!pending) { toast("There is no pending transcript."); return }
    const prompt = current()
    if (prompt.route !== pending.target.route || prompt.location !== pending.target.location) {
      throw new Error("Return to the session where this dictation started.")
    }
    if (!insertTranscript(prompt, prompt, pending.text)) {
      throw new Error("Focus the normal prompt and clear any text selection first.")
    }
    pending = undefined
    target = undefined
    publish()
    toast("Pending dictation inserted. Review before sending.", "success")
  }

  const schedule = (operation: () => Promise<void>): void => {
    // Let a palette/dialog release focus; every operation checks the live target again.
    setTimeout(() => { if (!disposed) void operation().catch(report) }, 0)
  }
  context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "local.dictation.toggle", title: "Start/stop local dictation", group: "Local dictation",
        palette: true, slash: { name: "dictate" }, run: () => schedule(toggle),
      },
      {
        id: "local.dictation.stop", title: "Stop dictation and transcribe", group: "Local dictation",
        palette: true, slash: { name: "dictate-stop" }, run: () => schedule(finish),
      },
      {
        id: "local.dictation.cancel", title: "Cancel local dictation", group: "Local dictation",
        palette: true, slash: { name: "dictate-cancel" }, run: () => schedule(cancel),
      },
      {
        id: "local.dictation.insert", title: "Insert pending dictation", group: "Local dictation",
        palette: true, slash: { name: "dictate-insert" }, run: () => schedule(insertPending),
      },
    ],
  }))
  return () => {
    onPreview({ phase: "idle", draft: "", pending: false })
    disposed = true
    generation++
    clearTimeout(limit)
    pending = undefined
    void controller.cancel().catch((error) => {
      console.error("Local dictation cleanup failed:", error instanceof Error ? error.message : String(error))
    })
  }
}
