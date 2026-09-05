import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * Reads Rust source for a build-time gate.
 *
 * `relative` may name a single file (`src/crypto.rs`) or a module tree
 * (`src/runtime.rs` where the module now lives in `src/runtime/`). Module
 * trees are concatenated in lexical file order so existing substring gates
 * keep working after the module split.
 */
export function rustSource(root, relative) {
  const direct = path.join(root, relative)
  if (exists(direct) && statSync(direct).isFile()) {
    return normalise(readFileSync(direct, 'utf8'))
  }

  const directory = path.join(root, relative.replace(/\.rs$/, ''))
  if (exists(directory) && statSync(directory).isDirectory()) {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.rs'))
      .map((entry) => entry.name)
      .sort()
      .map((name) => normalise(readFileSync(path.join(directory, name), 'utf8')))
      .join('\n')
  }

  throw new Error(`Rust source not found (file or module): ${relative}`)
}

function normalise(text) {
  return text.replace(/\r\n/g, '\n')
}

function exists(target) {
  try {
    statSync(target)
    return true
  } catch {
    return false
  }
}
