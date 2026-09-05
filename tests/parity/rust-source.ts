import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * Reads Rust source for a contract assertion.
 *
 * A `path` may name either a single file (`src/crypto.rs`) or a module tree
 * (`src/runtime.rs` where the module now lives in `src/runtime/`). For module
 * trees every `.rs` file is concatenated in lexical order, which keeps the
 * source-text assertions in these suites meaningful after the module split
 * while staying order-independent (`toContain` / `not.toContain`).
 */
export function rustSource(root: string, relative: string): string {
  const direct = path.join(root, relative)
  if (statSyncExists(direct) && statSync(direct).isFile()) {
    return normalise(readFileSync(direct, 'utf8'))
  }

  const directory = path.join(root, relative.replace(/\.rs$/, ''))
  if (statSyncExists(directory) && statSync(directory).isDirectory()) {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.rs'))
      .map((entry) => entry.name)
      .sort()
      .map((name) => normalise(readFileSync(path.join(directory, name), 'utf8')))
      .join('\n')
  }

  throw new Error(`Rust source not found (file or module): ${relative}`)
}

function normalise(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

function statSyncExists(target: string): boolean {
  try {
    statSync(target)
    return true
  } catch {
    return false
  }
}
