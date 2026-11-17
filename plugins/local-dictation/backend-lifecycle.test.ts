import { expect, test } from "bun:test"
import type { spawn, ChildProcessWithoutNullStreams } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { launch, type LaunchOptions } from "./backend"

function fixture(options: LaunchOptions = {}, binary = false, allowed = [0]) {
  let kills = 0
  let spawns = 0
  const abort = new AbortController()
  const child = Object.assign(new EventEmitter(), {
    pid: 123 as number | undefined,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: () => { kills++; return true },
  }) as unknown as ChildProcessWithoutNullStreams
  const stderr: string[] = []
  const spawnProcess = (() => { spawns++; return child }) as typeof spawn
  const running = launch("injected", [], abort.signal, 60_000, allowed,
    (text) => stderr.push(text), binary, { ...options, spawnProcess })
  return {
    child, running, abort, stderr,
    kills: () => kills, spawns: () => spawns,
    close: (code: number | null = 0) => child.emit("close", code),
  }
}

test("launch waits for close rather than treating a sent kill as completion", async () => {
  const f = fixture()
  f.abort.abort()
  let settled = false
  void f.running.done.catch(() => { settled = true })
  await Promise.resolve()
  expect(f.kills()).toBe(1)
  expect(f.running.closed()).toBe(false)
  expect(settled).toBe(false)
  f.close(null)
  await expect(f.running.done).rejects.toThrow("Dictation cancelled.")
  expect(f.running.closed()).toBe(true)
})

test("an error settles done without claiming the spawned child actually closed", async () => {
  const f = fixture()
  const error = new Error("injected process error")
  try {
    f.child.emit("error", error)
    expect(await f.running.done.catch((caught) => caught)).toBe(error)
    expect(f.running.closed()).toBe(false)
  } finally { f.close() }
})

test("terminate is memoized and waits for actual close after an earlier error", async () => {
  const f = fixture()
  try {
    f.child.emit("error", new Error("active failure"))
    const first = f.running.terminate!()
    expect(f.running.terminate!()).toBe(first)
    let settled = false
    void first.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(f.kills()).toBe(1)
    f.close(null)
    await first
  } finally { f.close() }
})

test("terminate reports an unreaped child within its injected bound and never kills twice", async () => {
  const waits: { milliseconds: number; message: string }[] = []
  const f = fixture({ waitFor: async (_promise, milliseconds, message) => {
    waits.push({ milliseconds, message })
    throw new Error(message)
  } })
  try {
    const first = f.running.terminate!()
    await expect(first).rejects.toThrow("Local audio process did not close after termination.")
    expect(f.running.terminate!()).toBe(first)
    expect(f.running.closed()).toBe(false)
    expect(f.kills()).toBe(1)
    expect(waits).toEqual([{
      milliseconds: 2_000, message: "Local audio process did not close after termination.",
    }])
  } finally { f.close(null) }
})

test("a failed spawn rejects with its original error and is never killed", async () => {
  const f = fixture()
  const error = new Error("spawn ENOENT")
  try {
    Object.assign(f.child, { pid: undefined })
    f.child.emit("error", error)
    expect(await f.running.done.catch((caught) => caught)).toBe(error)
    await f.running.terminate!()
    expect(f.kills()).toBe(0)
    expect(f.running.closed()).toBe(false)
  } finally { f.close() }
})

test("launch retains allowed exit codes and bounded UTF-8 stdout/stderr", async () => {
  const f = fixture({}, false, [0, 1])
  f.child.stdout.emit("data", "x".repeat(33_000) + "español")
  f.child.stderr.emit("data", "y".repeat(33_000) + "device")
  f.close(1)
  const result = await f.running.done
  expect(result.code).toBe(1)
  expect(result.stdout).toBe(("x".repeat(33_000) + "español").slice(-32_000))
  expect(result.stderr).toBe(("y".repeat(33_000) + "device").slice(-32_000))
  expect(f.stderr).toEqual([result.stderr])
  expect(f.kills()).toBe(0)
})

test("launch retains default exit errors and does not decode or collect binary stdout", async () => {
  const f = fixture({}, true)
  const raw = Buffer.from([0, 255, 128, 1])
  const chunks: Buffer[] = []
  f.child.stdout.on("data", (chunk) => chunks.push(chunk))
  f.child.stdout.emit("data", raw)
  f.child.stderr.emit("data", "diagnostic")
  f.close(7)
  await expect(f.running.done).rejects.toThrow("Local audio process failed (7): diagnostic")
  expect(chunks).toEqual([raw])
  const accepted = fixture({}, true)
  accepted.child.stdout.emit("data", raw)
  accepted.close()
  expect((await accepted.running.done).stdout).toBe("")
})

test("stdin EPIPE remains harmless while genuine input failures keep their identity", async () => {
  const f = fixture()
  f.child.stdin.emit("error", Object.assign(new Error("closed input"), { code: "EPIPE" }))
  expect(f.kills()).toBe(0)
  const error = new Error("input failed")
  f.child.stdin.emit("error", error)
  f.abort.abort()
  f.close(null)
  expect(await f.running.done.catch((caught) => caught)).toBe(error)
  expect(f.kills()).toBe(1)
})

test("an already aborted launch never spawns a child", () => {
  const abort = new AbortController()
  abort.abort(new Error("external cancellation"))
  let spawns = 0
  const spawnProcess = (() => { spawns++; throw new Error("must not spawn") }) as typeof spawn
  expect(() => launch("injected", [], abort.signal, 10, [0], undefined, false, { spawnProcess }))
    .toThrow("external cancellation")
  expect(spawns).toBe(0)
})
