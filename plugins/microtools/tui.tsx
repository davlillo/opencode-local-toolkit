/**
 * OpenCode Microtools - TUI part.
 *
 * Shows cumulative savings beside the prompt and answers /microtools with a
 * detailed summary. Reads the server plugin's stats file; it never writes.
 */

import { dirname, join } from "node:path"
import { Plugin } from "@opencode/plugin/tui"
import { formatBytes, formatTokens, readStats } from "./stats.ts"

export default Plugin.define({
  id: "opencode-microtools.status",
  setup(context) {
    if (context.app.version.replace(/^v/, "") !== "2.3.0") return
    const dataDir = process.env.OPENCODE_MICROTOOLS_DIR
      ? dirname(process.env.OPENCODE_MICROTOOLS_DIR)
      : join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "opencode-microtools")
    const statsPath = join(dataDir, "stats.ndjson")

    const [stats, update] = context.storage.memory("savings", { initial: { savedTokens: 0, entries: 0 } })
    const apply = (savedTokens: number, entries: number) => {
      if (stats.savedTokens === savedTokens && stats.entries === entries) return
      update((state) => { state.savedTokens = savedTokens; state.entries = entries })
    }
    const refresh = () => { void readStats(statsPath).then((s) => apply(s.savedTokens, s.entries)) }
    refresh()
    const timer = setInterval(refresh, 5_000)

    const detail = async () => {
      const s = await readStats(statsPath)
      if (!s.entries) {
        context.ui.toast.show({
          title: "Microtools",
          message: "Nothing reduced yet. Results over 8 KB start being compacted automatically.",
          variant: "info", duration: 8_000,
        })
        return
      }
      const top = Object.entries(s.byReducer)
        .sort((a, b) => b[1].savedTokens - a[1].savedTokens)[0]
      const label = top ? `${top[0]} (${top[1].count}×, ~${formatTokens(top[1].savedTokens)} tok)` : "n/a"
      context.ui.toast.show({
        title: "Microtools savings",
        message: `${s.entries} results compacted: saved ≈${formatTokens(s.savedTokens)} tokens`
          + ` (${formatBytes(s.originalBytes)} became ${formatBytes(s.outputBytes)}). Top: ${label}.`
          + " Token counts are chars/4 estimates.",
        variant: "success", duration: 10_000,
      })
    }

    context.keymap.layer(() => ({
      commands: [{
        id: "opencode.microtools.stats", title: "Show microtools savings", group: "Microtools",
        palette: true, slash: { name: "microtools" }, run: () => { void detail() },
      }],
    }))

    const removeFooter = context.ui.slot({
      append: "prompt.footer.status",
      render: () => <text fg={context.theme.text.base}>
        {stats.savedTokens > 0 ? ` MT −~${formatTokens(stats.savedTokens)} tok ` : ""}
      </text>,
    })
    return () => { clearInterval(timer); removeFooter() }
  },
})
