/**
 * Test support. Synchronous scratch directory, removed by the OS temp cleanup.
 */

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export interface ScratchStore {
  dir: string
}

export function makeScratchStore(prefix = "microtools-test-"): ScratchStore {
  return { dir: mkdtempSync(join(tmpdir(), prefix)) }
}
