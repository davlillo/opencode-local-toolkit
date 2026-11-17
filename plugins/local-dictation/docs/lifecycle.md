# Bounded streaming shutdown

Stopping returns a finalized transcript only after capture and recognition close successfully.
Intentional shutdown is marked **before** aborting either owned process, so teardown cannot publish
late drafts or an extra fatal `Dictation cancelled.` callback. Unexpected active failures still report once.
The prompt/controller guards and public `StreamingRecording` interface are unchanged.

## State and ownership

- One private `AbortController` owns the recognizer and capture processes. Caller cancellation also
  rejects startup gates; internal cleanup does not abort the caller's signal.
- Readiness still requires the worker's `ready` protocol message and capture's `Output #0,` marker.
  PCM uses the existing backpressured binary stream pipe, not a transcript buffer or audio file.
- `finish()` is memoized. It requests capture stop, waits for capture close, then waits for recognizer
  close and a complete newline-terminated final message. A final message alone is not success.
- `cancel()` and underlying cleanup are memoized, including failures. Cleanup unpipes audio, aborts
  the owned group and attempts **both** child terminations concurrently, even if one fails.

## Bounds and errors

| Operation | Default deadline |
| --- | --- |
| Recognizer readiness | 20 seconds |
| Capture readiness | 10 seconds |
| Capture stop | 10 seconds |
| Recognizer final flush | 10 seconds |
| Each owned child's termination/close acknowledgement | 2 seconds, concurrently |

These are separate stage bounds, not an extension of the test runner's outer timeout.
Existing process lifetime limits and launch exit-code/output defaults remain in place.

`launch()` keeps process-result settlement separate from an actual `close` event. Sending a kill,
or receiving an error from a spawned child, does not set `closed()` to true. Its optional, idempotent
`terminate()` waits for close and rejects if close is not acknowledged within the bound. A failed
spawn with no child PID owns no OS child and is not killed. No PID-based termination or process
enumeration is used.

Failed cleanup produces an `AggregateError` naming each child that did not close and logs those
diagnostics. When finish/startup already has an error, that exact original error is preserved;
extensible errors also receive a non-enumerable `cleanupError` diagnostic. Frozen errors retain
their identity and are still accompanied by the explicit cleanup log. A later controller cleanup
cannot replace the original finish error with the cleanup error.

## Deterministic verification

```sh
bun test ./streaming-lifecycle.test.ts ./backend-lifecycle.test.ts --timeout 2000 --no-env-file
```

The tests exercise the public streaming backend and the real `launch()` implementation with
injected child handles, streams and deadline promises. They cover final-flush timeout, stalled
capture stop, missing/incomplete final output at EOF, unexpected failure, external abort,
repeated cleanup, late protocol, primary-error identity, binary backpressure, optional legacy
handles, and acknowledged versus missing child close events. No microphone, model inference,
spawned fake child processes or real ten-second waits are needed.

**Proof boundary:** an injected `close` event proves how the implementation responds to a
reported close; it does **not** prove Windows/FFmpeg/Python actually exited or that an OS process
was reaped. Real-process close/reaping, running-host behavior and real speech accuracy remain
unverified by this suite. The historical exhausted process corpus was not replayed.

The shared launch helper retains the original positional arguments and adds only an optional
dependency argument. Streaming adds optional `launchProcess` and `waitFor` dependencies with
production defaults; older injected handles need not implement `terminate()`. The legacy Whisper
backend, device enumeration and transcription commands are not rewritten. Generic launch-contract
tests protect their shared defaults, but are not an actual Whisper runtime test.
