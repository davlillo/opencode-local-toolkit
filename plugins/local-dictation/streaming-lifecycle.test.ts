import { expect, test } from "bun:test"
import type { spawn, ChildProcessWithoutNullStreams } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough, Writable } from "node:stream"
import { launch, type ProcessWait } from "./backend"
import { WindowsStreamingBackend } from "./streaming-backend"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function microtasks() {
  for (let count = 0; count < 16; count++) await Promise.resolve()
}

function childFixture() {
  let closed = false
  const state = {
    kills: 0, closeOnKill: true, holdWrites: false,
    bytes: [] as Buffer[], writes: [] as (() => void)[],
    onEnd: () => {},
  }
  const stdin = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      state.bytes.push(Buffer.from(chunk))
      if (state.holdWrites) state.writes.push(callback)
      else callback()
    },
    final(callback) { state.onEnd(); callback() },
  })
  const child = Object.assign(new EventEmitter(), {
    pid: 123, killed: false, stdin, stdout: new PassThrough(), stderr: new PassThrough(),
    kill() {
      state.kills++
      this.killed = true
      if (state.closeOnKill) queueMicrotask(() => close(null))
      return true
    },
  }) as unknown as ChildProcessWithoutNullStreams
  function close(code: number | null = 0) {
    if (closed) return
    closed = true
    child.stdout.end()
    child.emit("close", code)
  }
  return {
    child, state, close,
    message: (message: object) => child.stdout.emit("data", JSON.stringify(message) + "\n"),
  }
}

function fixture(ready = true, legacyHandle = false) {
  const worker = childFixture()
  const capture = childFixture()
  capture.state.onEnd = () => capture.close()
  const waits: { milliseconds: number; message: string; expire(error?: Error): void }[] = []
  const waitFor: ProcessWait = (promise, milliseconds, message) => {
    const deadline = deferred<never>()
    waits.push({ milliseconds, message, expire: (error = new Error(message)) => deadline.reject(error) })
    return Promise.race([promise, deadline.promise])
  }
  const launched = deferred<void>()
  const launches: { signal: AbortSignal; binary: boolean; timeout: number; allowed?: number[] }[] = []
  const launchProcess: typeof launch = (executable, args, signal, timeout, allowed, onStderr, binary = false) => {
    const target = args[0] === "worker" ? worker : capture
    launches.push({ signal, binary, timeout, allowed })
    const running = launch(executable, args, signal, timeout, allowed, onStderr, binary, {
      spawnProcess: (() => target.child) as typeof spawn, waitFor,
    })
    queueMicrotask(() => {
      if (target === worker) {
        if (ready) worker.message({ type: "ready" })
        launched.resolve()
      } else capture.child.stderr.write("Output #0, raw PCM")
    })
    return legacyHandle ? { child: running.child, done: running.done, closed: running.closed } : running
  }
  const backend = new WindowsStreamingBackend({
    model: import.meta.dir,
    workerCommand: { executable: process.execPath, args: ["worker"] },
    captureCommand: { executable: process.execPath, args: ["capture"] },
    launchProcess, waitFor,
  })
  const abort = new AbortController()
  const drafts: string[] = []
  const failures: Error[] = []
  return {
    backend, worker, capture, waits, launches, abort, drafts, failures, launched,
    start: () => backend.startStream(abort.signal, (text) => drafts.push(text), (error) => failures.push(error)),
    deadline: (message: string) => {
      const wait = waits.find((entry) => entry.message === message)
      expect(wait).toBeDefined()
      return wait!
    },
    dispose() {
      capture.close()
      worker.close()
      worker.state.writes.splice(0).forEach((write) => write())
    },
  }
}

test("B1: final-flush timeout and intentional release never emit fatal cancellation", async () => {
  const f = fixture()
  try {
    const recording = await f.start()
    f.worker.message({ type: "final", text: "must not succeed without close" })
    const finishing = recording.finish().catch((error) => error)
    await microtasks()
    const primary = new Error("Local recognizer did not flush its final result.")
    f.deadline(primary.message).expire(primary)
    expect(await finishing).toBe(primary)
    await recording.cancel()
    expect(f.failures).toEqual([])
    expect(f.worker.state.kills).toBe(1)
    expect(f.capture.state.kills).toBe(0)
  } finally { f.dispose() }
})

test("finish is memoized, retains live drafts and only succeeds after both close events", async () => {
  const f = fixture()
  try {
    const recording = await f.start()
    f.worker.message({ type: "partial", text: "hola" })
    f.worker.message({ type: "partial", text: "hola mundo" })
    f.capture.state.onEnd = () => {
      f.capture.close()
      f.worker.message({ type: "final", text: "hola mundo" })
      f.worker.close()
    }
    const first = recording.finish()
    expect(recording.finish()).toBe(first)
    expect(await first).toBe("hola mundo")
    f.worker.message({ type: "partial", text: "late" })
    f.worker.message({ type: "error", message: "late error" })
    expect(f.drafts).toEqual(["hola", "hola mundo"])
    expect(f.failures).toEqual([])
    await recording.cancel()
  } finally { f.dispose() }
})

for (const tail of ["", '{"type":"final","text":"incomplete"}']) {
  test(`EOF without a complete final message rejects and cannot produce a successful transcript (${tail.length})`,
    async () => {
      const f = fixture()
      try {
        const recording = await f.start()
        const finishing = recording.finish().catch((error) => error)
        f.worker.child.stdout.write(tail)
        f.worker.close()
        const error = await finishing
        expect(error.message).toBe("Recognizer ended without a complete result.")
        await recording.cancel()
        expect(f.failures.length).toBeLessThanOrEqual(1)
      } finally { f.dispose() }
    })
}

test("unexpected active protocol failure is reported exactly once with its original identity", async () => {
  const f = fixture()
  try {
    const recording = await f.start()
    f.worker.message({ type: "error", message: "decoder disconnected" })
    f.worker.message({ type: "partial", text: "stale" })
    f.capture.child.emit("error", new Error("secondary failure"))
    await microtasks()
    expect(f.failures).toHaveLength(1)
    expect(f.failures[0]!.message).toBe("decoder disconnected")
    expect(await recording.finish().catch((error) => error)).toBe(f.failures[0])
    await recording.cancel()
    expect(f.drafts).toEqual([])
  } finally { f.dispose() }
})

test("external abort suppresses late messages and repeated cleanup shares one promise", async () => {
  const f = fixture()
  try {
    const recording = await f.start()
    const reason = new Error("caller aborted")
    f.abort.abort(reason)
    f.worker.message({ type: "partial", text: "stale" })
    expect(await recording.finish().catch((error) => error)).toBe(reason)
    const first = recording.cancel()
    expect(recording.cancel()).toBe(first)
    await first
    expect(f.failures).toEqual([])
    expect(f.drafts).toEqual([])
    expect([f.worker.state.kills, f.capture.state.kills]).toEqual([1, 1])
  } finally { f.dispose() }
})

test("intentional cancel ignores even malformed late protocol while close is pending", async () => {
  const f = fixture()
  try {
    const recording = await f.start()
    f.worker.state.closeOnKill = false
    f.capture.state.closeOnKill = false
    const cancelled = recording.cancel()
    void cancelled.catch(() => {})
    f.worker.message({ type: "partial", text: "late draft" })
    f.worker.child.stdout.write("not JSON\n")
    expect(f.drafts).toEqual([])
    expect(f.failures).toEqual([])
    expect(recording.cancel()).toBe(cancelled)
    f.dispose()
    await cancelled
  } finally { f.dispose() }
})

test("a stalled capture stop has its own deadline and preserves that finish error", async () => {
  const f = fixture()
  try {
    const recording = await f.start()
    f.capture.state.onEnd = () => {}
    const finishing = recording.finish().catch((error) => error)
    await microtasks()
    const primary = new Error("Audio capture did not stop.")
    f.deadline(primary.message).expire(primary)
    expect(await finishing).toBe(primary)
    await recording.cancel()
    expect(f.failures).toEqual([])
    expect([f.worker.state.kills, f.capture.state.kills]).toEqual([1, 1])
  } finally { f.dispose() }
})

test("cleanup attempts both children and preserves the primary finish error with explicit close diagnostics", async () => {
  const f = fixture()
  try {
    const recording = await f.start()
    f.capture.state.onEnd = () => {}
    f.worker.state.closeOnKill = false
    f.capture.state.closeOnKill = false
    const finishing = recording.finish().catch((error) => error)
    await microtasks()
    const primary = new Error("Audio capture did not stop.")
    f.deadline(primary.message).expire(primary)
    await microtasks()
    const closes = f.waits.filter((wait) => wait.message === "Local audio process did not close after termination.")
    expect(closes).toHaveLength(2)
    closes.forEach((wait) => wait.expire())
    expect(await finishing).toBe(primary)
    const cleanup = (primary as Error & { cleanupError?: AggregateError }).cleanupError
    expect(cleanup?.message).toBe("Local dictation cleanup failed.")
    expect(cleanup?.errors.map((error: Error) => error.message)).toEqual([
      "Recognizer did not close: Local audio process did not close after termination.",
      "Audio capture did not close: Local audio process did not close after termination.",
    ])
    expect(await recording.cancel().catch((error) => error)).toBe(primary)
    expect(f.failures).toEqual([])
    expect([f.worker.state.kills, f.capture.state.kills]).toEqual([1, 1])
  } finally { f.dispose() }
})

test("standalone cancel reports the child that did not close while still waiting for the other", async () => {
  const f = fixture()
  try {
    const recording = await f.start()
    f.worker.state.closeOnKill = false
    const cancelled = recording.cancel().catch((error) => error)
    await microtasks()
    const closes = f.waits.filter((wait) => wait.message === "Local audio process did not close after termination.")
    expect(closes).toHaveLength(2)
    closes[0]!.expire()
    const error = await cancelled
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.errors.map((failure: Error) => failure.message)).toEqual([
      "Recognizer did not close: Local audio process did not close after termination.",
    ])
    expect([f.worker.state.kills, f.capture.state.kills]).toEqual([1, 1])
    expect(f.failures).toEqual([])
  } finally { f.dispose() }
})

test("recognizer readiness timeout releases its child and does not open capture", async () => {
  const f = fixture(false)
  try {
    const started = f.start().catch((error) => error)
    await f.launched.promise
    await microtasks()
    const primary = new Error("Local recognizer did not become ready.")
    f.deadline(primary.message).expire(primary)
    expect(await started).toBe(primary)
    expect(f.launches).toHaveLength(1)
    expect(f.worker.state.kills).toBe(1)
    expect(f.failures).toEqual([])
  } finally { f.dispose() }
})

test("the existing raw PCM pipe remains binary and backpressured with one owned abort group", async () => {
  const f = fixture()
  try {
    const recording = await f.start()
    f.worker.state.holdWrites = true
    const pcm = Buffer.alloc(32_768, 255)
    f.capture.child.stdout.write(pcm)
    expect(f.capture.child.stdout.isPaused()).toBe(true)
    expect(Buffer.concat(f.worker.state.bytes)).toEqual(pcm)
    expect(f.launches.map((call) => [call.binary, call.timeout])).toEqual([[false, 95_000], [true, 75_000]])
    expect(f.launches[0]!.signal).toBe(f.launches[1]!.signal)
    expect(f.launches[0]!.signal).not.toBe(f.abort.signal)
    expect(f.launches[1]!.allowed).toEqual([0])
    await recording.cancel()
  } finally { f.dispose() }
})

test("injected handles without the optional terminate method still wait for close and clean up once", async () => {
  const f = fixture(true, true)
  try {
    const recording = await f.start()
    f.worker.state.closeOnKill = false
    f.capture.state.closeOnKill = false
    const cancelled = recording.cancel()
    expect(recording.cancel()).toBe(cancelled)
    await microtasks()
    expect([f.worker.state.kills, f.capture.state.kills]).toEqual([1, 1])
    expect(f.waits.filter((wait) => wait.message === "Local audio process did not close after termination."))
      .toHaveLength(2)
    f.dispose()
    await cancelled
    expect(f.failures).toEqual([])
  } finally { f.dispose() }
})
