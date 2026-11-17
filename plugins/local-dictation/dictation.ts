export interface Recording {
  stop(): Promise<string>
  cancel(): Promise<void>
}

export interface Backend {
  start(signal: AbortSignal): Promise<Recording>
  transcribe(file: string, signal: AbortSignal): Promise<string>
}

export interface StreamingRecording {
  finish(): Promise<string>
  cancel(): Promise<void>
}

export interface StreamingBackend {
  startStream(
    signal: AbortSignal,
    onDraft: (text: string) => void,
    onFailure?: (error: Error) => void,
  ): Promise<StreamingRecording>
}

export type Phase = "idle" | "starting" | "recording" | "transcribing" | "cancelling"

export interface PromptEditor {
  id: string
  isDestroyed: boolean
  focused: boolean
  focusable: boolean
  traits: { owner?: string; role?: string; status?: string }
  hasSelection(): boolean
  insertText(text: string): void
}

export interface PromptTarget {
  editor: PromptEditor | null
  id: string | undefined
  route: string
  location: string
}

export class DictationController {
  phase: Phase = "idle"
  private revision = 0
  private abort?: AbortController
  private recording?: StreamingRecording

  constructor(
    private readonly backend: Backend | StreamingBackend,
    private readonly onPhase: (phase: Phase) => void = () => {},
    private readonly onDraft: (text: string) => void = () => {},
    private readonly onFailure: (error: unknown) => void = () => {},
  ) {}

  private setPhase(phase: Phase): void {
    this.phase = phase
    this.onPhase(phase)
  }

  async start(): Promise<void> {
    if (this.phase !== "idle") throw new Error("Dictation is already active.")
    const revision = ++this.revision
    const abort = new AbortController()
    this.abort = abort
    this.setPhase("starting")
    let recording: StreamingRecording
    try {
      const backend = this.backend
      if ("startStream" in backend) {
        recording = await backend.startStream(abort.signal, (text) => {
          if (revision === this.revision && !abort.signal.aborted
            && this.phase !== "idle" && this.phase !== "cancelling") {
            this.onDraft(normalizeTranscript(text))
          }
        }, (error) => {
          if (revision !== this.revision || abort.signal.aborted) return
          void this.cancel().then(() => {
            if (this.revision === revision + 1) this.onFailure(error)
          }).catch(this.onFailure)
        })
      } else {
        const captured = await backend.start(abort.signal)
        recording = {
          finish: async () => {
            const file = await captured.stop()
            abort.signal.throwIfAborted()
            return backend.transcribe(file, abort.signal)
          },
          cancel: () => captured.cancel(),
        }
      }
    } catch (error) {
      if (revision !== this.revision) return
      this.abort = undefined
      this.setPhase("idle")
      throw error
    }
    if (revision !== this.revision) {
      await recording.cancel()
      return
    }
    this.recording = recording
    this.setPhase("recording")
  }

  async stop(): Promise<string | undefined> {
    if (this.phase !== "recording" || !this.recording || !this.abort) return
    const revision = this.revision
    const recording = this.recording
    this.setPhase("transcribing")
    try {
      const text = await recording.finish()
      if (revision === this.revision) return normalizeTranscript(text)
    } catch (error) {
      if (revision === this.revision) throw error
    } finally {
      try {
        await recording.cancel()
      } finally {
        if (revision === this.revision) {
          this.recording = undefined
          this.abort = undefined
          this.setPhase("idle")
        }
      }
    }
  }

  async cancel(): Promise<void> {
    const revision = ++this.revision
    this.abort?.abort()
    const recording = this.recording
    this.recording = undefined
    this.abort = undefined
    this.setPhase("cancelling")
    try {
      await recording?.cancel()
    } finally {
      if (revision === this.revision) this.setPhase("idle")
    }
  }
}

export function isPromptEditor(value: unknown): value is PromptEditor {
  if (!value || typeof value !== "object") return false
  const editor = value as Partial<PromptEditor>
  return typeof editor.insertText === "function"
    && typeof editor.hasSelection === "function"
    && editor.traits?.owner === "opencode"
    && editor.traits?.role === "prompt"
}

export function canInsert(target: PromptTarget, current: PromptTarget): boolean {
  const editor = current.editor
  return !!editor && isPromptEditor(editor)
    && target.editor === editor && target.id === current.id
    && target.route === current.route && target.location === current.location
    && !editor.isDestroyed && editor.focused && editor.focusable
    && editor.traits.status !== "SHELL" && !editor.hasSelection()
}

export function insertTranscript(target: PromptTarget, current: PromptTarget, text: string): boolean {
  if (!canInsert(target, current)) return false
  current.editor!.insertText(text)
  return true
}

export function normalizeTranscript(text: string): string {
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()
}

export function parseAudioDevices(text: string): string[] {
  return [...new Set([...text.matchAll(/"([^"\r\n]+)"\s+\(audio\)/g)].map((match) => match[1]!))]
}
