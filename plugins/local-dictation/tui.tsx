import { Plugin } from "@opencode/plugin/tui"
import { installDictation, previewVisible, viewIdentity, type PreviewState } from "./integration"
import { DictationControls, DictationPreview } from "./controls"

export default Plugin.define({
  id: "local.dictation",
  setup(context) {
    if (context.app.version.replace(/^v/, "") !== "2.3.0") {
      context.ui.toast.show({
        title: "Local dictation is inactive",
        message: "This prompt integration is verified for OpenCode 2.3.0 only. Review compatibility before enabling it.",
        variant: "warning",
      })
      return
    }
    const [status, update] = context.storage.memory<PreviewState>("live-status", {
      initial: { phase: "idle", draft: "", pending: false },
    })
    const setStatus = (view: PreviewState) => update((state) => {
      state.phase = view.phase
      state.draft = view.draft
      state.pending = view.pending
      state.route = view.route
      state.location = view.location
    })
    setStatus({ phase: "idle", draft: "", pending: false })
    const cleanup = installDictation(context, undefined, undefined, setStatus)
    const visible = () => {
      const current = viewIdentity(context)
      return previewVisible(status, current.route, current.location)
    }
    const sameTarget = () => {
      const current = viewIdentity(context)
      return status.route === current.route && status.location === current.location
    }
    const removeFooter = context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => <>{input.mode === "normal" || status.phase !== "idle" || status.pending
        ? <DictationControls phase={status.phase} pending={status.pending} sameTarget={sameTarget()}
          color={context.theme.text.base}
          compactDraft={!input.sessionID && visible() ? status.draft : undefined}
          onToggle={() => context.keymap.dispatch("local.dictation.toggle")}
          onCancel={() => context.keymap.dispatch("local.dictation.cancel")}
          onInsert={() => context.keymap.dispatch("local.dictation.insert")} />
        : null}</>,
    })
    const removePreview = context.ui.slot({
      append: "session.composer.top",
      render: (input) => <DictationPreview text={status.draft} pending={status.pending}
        visible={status.route === `session:${input.sessionID}` && visible()}
        color={context.theme.text.base} />,
    })
    return () => { removeFooter(); removePreview(); cleanup() }
  },
})
