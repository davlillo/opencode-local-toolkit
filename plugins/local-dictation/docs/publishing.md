# Publish only the source

No repository has been created and nothing has been uploaded by this revision.
GitHub source publication is separate from npm publication; keep `private: true`
unless registry publishing is separately requested.

## Decisions required before remote access

Record the exact GitHub owner/repository, public or private visibility, source
license, target branch and whether a tag/release is wanted. Obtain explicit
authorization to use the selected GitHub credential/session for those operations.
Do not discover or reuse ambient credentials to guess the owner.

No source license has been selected. Do not describe this plugin as open source
or infer a license from the separately licensed Vosk model.

## Source allowlist

Review and copy only these files to an otherwise empty publication directory.
Verify every listed file exists and inspect its final contents before staging.
The package `files` field controls a package archive, **not GitHub contents**.
Do not stage the home directory or run an indiscriminate `git add .`.

Paths below are relative to `plugins/local-dictation/` in the monorepo. The
repository root also publishes its own `README.md`, `.gitignore`, the shared
`docs/architecture.json`, `docs/architecture.svg` and `docs/architecture.html`,
plus the sibling `plugins/microtools/` package.

```text
.gitignore
package.json
README.md
requirements-vosk.lock
tui.tsx
controls.tsx
dictation.ts
integration.ts
backend.ts
streaming-backend.ts
audio-pipeline.ts
vosk-worker.py
native/vosk_api.h
native/CMakeLists.txt
native/build.ps1
native/test-protocol.ps1
native/src/main.cpp
worker_test.py
controls.test.tsx
dictation.test.ts
integration.test.ts
probes.test.ts
streaming.test.ts
streaming-backend.test.ts
live-integration.test.ts
streaming-lifecycle.test.ts
backend-lifecycle.test.ts
audio-pipeline.test.ts
tests/fake-worker.ts
tests/fake-capture.ts
docs/install.md
docs/audio-pipeline.md
docs/lifecycle.md
docs/native-core.md
docs/models.md
docs/publishing.md
```

Include a `LICENSE` only after its terms are explicitly selected. Update this
list when a necessary source or test fixture is intentionally added.

Never include `odd/`, private task history, user configuration, absolute
machine paths, model archives, environments, native binaries, recordings,
transcripts, generated artifacts or diagnostic scratch. Preserve private
diagnostics outside the publication directory when they are needed for recovery.

## Final checks

- Review the complete source export for secrets, private names and machine paths.
- Run functional and compatibility checks against those exact exported files.
- Keep missing host/microphone/typecheck/native-review proof explicit.
- Check the selected license and separate runtime/model license notices.
- Review the exact local diff before any commit or remote mutation.
- Publish only the authorized repository/branch; no force push, merge or deploy.
- Confirm the remote identity and published commit after success.

Publishing does not turn an experimental implementation or unavailable
verification into a passing result.
