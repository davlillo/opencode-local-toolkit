/**
 * OpenCode Microtools - server plugin entry.
 *
 * Shrinks completed tool results before they reach the model, and stores every
 * original so nothing is lost. Local and deterministic: no model calls.
 *
 * The host auto-discovers `index.ts` as the server entry, so the plugin lives
 * here and the reduction library surface is re-exported from `./lib.ts`.
 */

import { homedir } from "node:os"
import { join } from "node:path"
import { Plugin } from "@opencode/plugin"
import { createShrinkHandler } from "./host-result.ts"

function defaultStoreDir(): string {
  const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
  return join(local, "opencode-microtools", "originals")
}

export default Plugin.define({
  id: "opencode-microtools",
  async setup(ctx) {
    const handler = createShrinkHandler({
      storeDir: process.env.OPENCODE_MICROTOOLS_DIR ?? defaultStoreDir(),
      thresholdBytes: Number(process.env.OPENCODE_MICROTOOLS_THRESHOLD ?? "") || undefined,
      enabled: {
        build: process.env.OPENCODE_MICROTOOLS_BUILD !== "off",
        test: process.env.OPENCODE_MICROTOOLS_TEST !== "off",
        terminal: process.env.OPENCODE_MICROTOOLS_TERMINAL !== "off",
        search: process.env.OPENCODE_MICROTOOLS_SEARCH !== "off",
      },
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- host event type is opaque here
    await ctx.tool.hook("execute.after", (event: any) => handler(event))
  },
})
