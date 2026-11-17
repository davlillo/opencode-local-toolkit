import { expect, test } from "bun:test"
import { DictationController } from "./dictation"

function gate<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

test("publishes replaceable live hypotheses before stopping, then returns finalized text", async () => {
  let publish!: (text: string) => void
  let finished = false
  let cleaned = false
  const drafts: string[] = []
  const backend = {
    async startStream(_signal: AbortSignal, onDraft: (text: string) => void) {
      publish = onDraft
      return {
        async finish() { finished = true; return "  hola mundo\r\n en español  " },
        async cancel() { cleaned = true },
      }
    },
  }
  const controller = new DictationController(backend, undefined, (text) => drafts.push(text))
  await controller.start()
  publish("hola")
  publish("hola mundo")
  expect(drafts).toEqual(["hola", "hola mundo"])
  expect(finished).toBe(false)
  expect(controller.phase).toBe("recording")
  expect(await controller.stop()).toBe("hola mundo en español")
  expect(cleaned).toBe(true)
  publish("late result")
  expect(drafts).toEqual(["hola", "hola mundo"])
})

test("cancelled streaming startup ignores drafts and releases a late session", async () => {
  const ready = gate<{ finish(): Promise<string>; cancel(): Promise<void> }>()
  const drafts: string[] = []
  let publish!: (text: string) => void
  let cleaned = 0
  const controller = new DictationController({
    startStream: async (_signal: AbortSignal, onDraft: (text: string) => void) => {
      publish = onDraft
      return ready.promise
    },
  }, undefined, (text) => drafts.push(text))
  const started = controller.start()
  await controller.cancel()
  publish("must not appear")
  ready.resolve({ async finish() { return "unused" }, async cancel() { cleaned++ } })
  await started
  expect(drafts).toEqual([])
  expect(cleaned).toBe(1)
  expect(controller.phase).toBe("idle")
})

test("cancellation while flushing streaming audio discards all late output", async () => {
  const result = gate<string>()
  const drafts: string[] = []
  let publish!: (text: string) => void
  const controller = new DictationController({
    async startStream(_signal: AbortSignal, onDraft: (text: string) => void) {
      publish = onDraft
      return { finish: () => result.promise, async cancel() {} }
    },
  }, undefined, (text) => drafts.push(text))
  await controller.start()
  publish("current draft")
  const stopped = controller.stop()
  await controller.cancel()
  publish("stale hypothesis")
  result.resolve("stale final text")
  expect(await stopped).toBeUndefined()
  expect(drafts).toEqual(["current draft"])
})
